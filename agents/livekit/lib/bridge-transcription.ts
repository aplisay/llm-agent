/**
 * Transcription of the human↔human segment of a bridged transfer
 * (`options.bridgedTransferTranscribe`).
 *
 * After a bridged transfer the AI has left the conversation, so nothing
 * transcribes the caller↔transfer-target conversation. When the option is
 * set the worker collects a speaker-labelled transcript of that segment:
 * the muted agent participant stays connected to the room after
 * `detachPrimaryAgentMediaAfterBridge` (the same connection the
 * bridgedTransferToAgent DTMF watch rides on), so this module opens one
 * rtc-node {@link AudioStream} per bridged human — the caller and the
 * transfer target are distinct room participants with their own audio
 * tracks — and runs each through a fresh STT stream.
 *
 * STT vendor selection mirrors the worker's own pipeline resolution: the
 * agent's configured `options.stt` via LiveKit Inference
 * (`inference.STT.fromModelString(resolvePipelineStt(agent))`, exactly what
 * AgentSession does with a string `stt`), defaulting to Deepgram when the
 * agent is a realtime model with no pipeline STT configured — the same
 * default as pipecat's `build_stt_service`. When
 * `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS` is set the direct Deepgram plugin is
 * used instead, again matching the pipeline. `options.
 * bridgedTransferTranscribe.provider` is IGNORED on LiveKit (it tunes the
 * voiceblender container's native STT); `language` is honoured best-effort
 * by threading it through the agent's STT options.
 *
 * Final utterances land in a {@link BridgeTranscriptCollector}, which posts
 * each one to the bridged-segment call record's transaction log (`user` =
 * caller, `agent` = transfer target — the B-party occupies the agent slot
 * of a two-party transcript) following the worker's streamed-vs-batched
 * convention (`instance.streamLog`), and renders the merged history for the
 * takeover agent's prompt.
 *
 * Everything here is best-effort: an STT failure must never disturb the
 * bridged call or the DTMF watch. See the pipecat reference implementation
 * (agents/pipecat/pipecat_aplisay/bridge_transcript.py) and
 * docs/call-transfers.md ("Transcribing the bridged segment").
 */

import { inference, stt } from "@livekit/agents";
import { AudioStream, RoomEvent, TrackKind } from "@livekit/rtc-node";
import type {
  AudioFrame,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  Track,
} from "@livekit/rtc-node";
import type { ReadableStream } from "node:stream/web";
import logger from "./logger.js";
import { createTransactionLog } from "./api-client.js";
import type { Agent, Call, OrganisationKeys } from "./api-client.js";
import { resolvePipelineStt } from "./pipeline-inference-options.js";
import {
  buildProviderPipelineStt,
  pipelineUsesProviderApiKeys,
} from "./pipeline-provider-keys.js";
import { resolveOrganisationKey } from "./voice-session-factory.js";

/** Speaker labels — the exact strings pipecat's collector renders. */
export const CALLER = "caller";
export const TARGET = "transfer target";

/** caller → "user", transfer target → "agent" (the B-party occupies the agent slot). */
const SPEAKER_LOG_TYPE: Record<string, string> = {
  [CALLER]: "user",
  [TARGET]: "agent",
};

/** Both bridged humans are telephony audio; STT streams resample as needed. */
const BRIDGE_STT_SAMPLE_RATE = 16000;
/** How long to wait for a bridged participant / its audio track to appear. */
const TRACK_WAIT_TIMEOUT_MS = 15000;

/** Normalised `options.bridgedTransferTranscribe`. `provider` is unused on LiveKit. */
export interface BridgedTranscribeConfig {
  provider: string;
  language: string | null;
}

/**
 * Normalise `options.bridgedTransferTranscribe` to null (off) or
 * `{provider, language}`. Lenient — the server validated the shape at save
 * time. Mirrors pipecat's `parse_transcribe_option`: absent/false/
 * `enabled:false` → off; `true` → defaults.
 */
export function parseBridgedTranscribeOption(
  options: any,
): BridgedTranscribeConfig | null {
  const raw = options?.bridgedTransferTranscribe;
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return { provider: "elevenlabs", language: null };
  if (typeof raw !== "object" || Array.isArray(raw) || raw.enabled === false) {
    return null;
  }
  return {
    provider: String(raw.provider || "elevenlabs"),
    language: typeof raw.language === "string" && raw.language.trim()
      ? raw.language.trim()
      : null,
  };
}

/**
 * Accumulates final utterances from the two bridged humans (mirrors
 * pipecat's BridgeTranscriptCollector).
 *
 * `call` is the bridged-segment call record (`telephony:bridged-call`) the
 * entries are logged against; `streamLog` follows the worker's convention
 * (live POST per entry when `instance.streamLog`, otherwise batched onto
 * the record's `batchedTransactionLogs`, flushed by `call.end()`).
 */
export class BridgeTranscriptCollector {
  private readonly entries: Array<{
    at: number;
    speaker: string;
    text: string;
  }> = [];

  constructor(
    private readonly call: Call,
    private readonly streamLog: boolean,
    /** Injectable monotonic clock (tests). */
    private readonly now: () => number = () => performance.now(),
  ) {}

  get length(): number {
    return this.entries.length;
  }

  async add(speaker: string, text: string): Promise<void> {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    this.entries.push({ at: this.now(), speaker, text: trimmed });
    const entry = {
      userId: this.call.userId,
      organisationId: this.call.organisationId,
      callId: this.call.id,
      type: SPEAKER_LOG_TYPE[speaker] ?? "user",
      data: trimmed,
      isFinal: true,
      createdAt: new Date(),
    };
    if (this.streamLog) {
      try {
        await createTransactionLog(entry);
      } catch (e) {
        logger.warn(
          { e, callId: this.call.id },
          "bridgedTransferTranscribe: transcript log post failed",
        );
      }
    } else {
      const batched = ((this.call as any).batchedTransactionLogs ??= []);
      batched.push(entry);
    }
  }

  /**
   * Merged, chronologically ordered `> caller:` / `> transfer target:`
   * lines — same shape as `${parentTranscript}` and pipecat's render().
   */
  render(): string {
    return [...this.entries]
      .sort((a, b) => a.at - b.at)
      .map((e) => `> ${e.speaker}: ${e.text}\n`)
      .join("");
  }
}

/**
 * A fresh STT instance for one bridged human, safe to run alongside
 * anything else. Reuses the agent's configured STT vendor exactly as the
 * pipeline does — `inference.STT.fromModelString(resolvePipelineStt(...))`
 * (what AgentSession does with a string `stt`), whose default is Deepgram
 * nova-3 when `options.stt` is absent (realtime models) — or the direct
 * Deepgram plugin under LIVEKIT_PIPELINE_USE_PROVIDER_KEYS. A `language`
 * from the transcribe option overrides the agent's STT language.
 *
 * BYOK (docs/byok.md): an org deepgram key forces the direct plugin with
 * that key, mirroring the pipeline's own STT resolution in
 * voice-session-factory. A null/unreadable entry throws (fail-closed) —
 * the bridge segment must never silently run on the platform key.
 */
export function buildBridgeStt(
  agent: Agent,
  language?: string | null,
  organisationKeys?: OrganisationKeys,
): stt.STT {
  const effectiveAgent: Agent = language
    ? ({
        ...agent,
        options: {
          ...(agent.options || {}),
          stt: { ...((agent.options as any)?.stt || {}), language },
        },
      } as Agent)
    : agent;
  const sttOrgKey = resolveOrganisationKey(
    organisationKeys,
    resolvePipelineStt(effectiveAgent).startsWith("deepgram/")
      ? "deepgram"
      : undefined,
  );
  if (sttOrgKey !== undefined) {
    return buildProviderPipelineStt(effectiveAgent, sttOrgKey);
  }
  if (pipelineUsesProviderApiKeys()) {
    return buildProviderPipelineStt(effectiveAgent);
  }
  return inference.STT.fromModelString(resolvePipelineStt(effectiveAgent));
}

function findRemoteParticipant(
  room: Room,
  identity: string,
): RemoteParticipant | undefined {
  for (const p of room.remoteParticipants.values()) {
    if (p?.identity === identity) return p;
  }
  return undefined;
}

/** Resolve a room participant by identity, waiting for it to join if needed. */
function waitForRemoteParticipant(
  room: Room,
  identity: string,
  timeoutMs: number = TRACK_WAIT_TIMEOUT_MS,
): Promise<RemoteParticipant> {
  const existing = findRemoteParticipant(room, identity);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantConnected, onConnected);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`participant ${identity} did not join within ${timeoutMs}ms`),
      );
    }, timeoutMs);
    const onConnected = (p: RemoteParticipant) => {
      if (p?.identity === identity) {
        cleanup();
        resolve(p);
      }
    };
    room.on(RoomEvent.ParticipantConnected, onConnected);
    // Close the check-then-listen race.
    const now = findRemoteParticipant(room, identity);
    if (now) {
      cleanup();
      resolve(now);
    }
  });
}

function subscribedAudioTrack(
  participant: RemoteParticipant,
): Track | undefined {
  for (const pub of participant.trackPublications.values()) {
    if (pub.kind === TrackKind.KIND_AUDIO && pub.track) return pub.track;
  }
  return undefined;
}

/**
 * Resolve the participant's subscribed audio track. The worker connects
 * with AutoSubscribe.SUBSCRIBE_ALL (ctx.connect() default), so tracks
 * normally arrive subscribed; ask explicitly (setSubscribed) and wait on
 * RoomEvent.TrackSubscribed otherwise.
 */
function waitForAudioTrack(
  room: Room,
  participant: RemoteParticipant,
  timeoutMs: number = TRACK_WAIT_TIMEOUT_MS,
): Promise<Track> {
  const existing = subscribedAudioTrack(participant);
  if (existing) return Promise.resolve(existing);
  for (const pub of participant.trackPublications.values()) {
    if (pub.kind === TrackKind.KIND_AUDIO) {
      try {
        (pub as RemoteTrackPublication).setSubscribed(true);
      } catch (e) {
        logger.debug(
          { e, identity: participant.identity },
          "bridgedTransferTranscribe: setSubscribed failed",
        );
      }
    }
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `no subscribed audio track for ${participant.identity} within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    const onSubscribed = (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      p: RemoteParticipant,
    ) => {
      if (p?.identity === participant.identity && track.kind === TrackKind.KIND_AUDIO) {
        cleanup();
        resolve(track);
      }
    };
    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    // Close the check-then-listen race.
    const now = subscribedAudioTrack(participant);
    if (now) {
      cleanup();
      resolve(now);
    }
  });
}

/** Live bridged-segment transcription: snapshot for the takeover prompt + teardown. */
export interface BridgeTranscriptionHandle {
  /** Chronologically merged `> caller:` / `> transfer target:` lines so far. */
  render(): string;
  /** Stop both STT streams and audio pumps. Idempotent. */
  dispose(): void;
}

export interface ArmBridgedTranscriptionParams {
  /** The worker's connected RTC room (ctx.room). */
  room: Room;
  /** Server-side room name, for logging. */
  roomName: string;
  /** Identity of the original caller participant. */
  callerIdentity?: string | null;
  /** Identity of the bridged transfer-target participant. */
  targetIdentity: string;
  /** The telephony:bridged-call record covering the caller↔target bridge. */
  bridgedCall: Call;
  /** The transferring agent — source of the STT vendor configuration. */
  agent: Agent;
  transcribe: BridgedTranscribeConfig;
  /** instance.streamLog: live transaction-log POST per utterance vs batch. */
  streamLog: boolean;
  /**
   * Org BYOK provider keys for this call (docs/byok.md), read from the
   * fetched instance doc. Consumed only as the STT plugin's constructor
   * apiKey; never logged.
   */
  organisationKeys?: OrganisationKeys;
}

/**
 * Arm bridged-segment transcription: one STT stream per bridged human,
 * fed from that participant's room audio track. Self-disposes when either
 * bridged leg disconnects or the room connection drops; the takeover path
 * disposes it explicitly. Never throws — transcription is best-effort.
 */
export function armBridgedTranscription(
  params: ArmBridgedTranscriptionParams,
): BridgeTranscriptionHandle {
  const {
    room,
    roomName,
    callerIdentity,
    targetIdentity,
    bridgedCall,
    agent,
    transcribe,
    streamLog,
    organisationKeys,
  } = params;

  const collector = new BridgeTranscriptCollector(bridgedCall, streamLog);
  let disposed = false;
  const cleanups: Array<() => void> = [];

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.off(RoomEvent.Disconnected, onRoomDisconnected);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch (e) {
        logger.debug({ e, roomName }, "bridgedTransferTranscribe: cleanup step failed");
      }
    }
    logger.debug(
      { roomName, entries: collector.length },
      "bridgedTransferTranscribe: transcription disposed",
    );
  };

  const onParticipantDisconnected = (p: RemoteParticipant): void => {
    const identity = p?.identity ?? (p as any)?.info?.identity;
    if (
      identity === targetIdentity ||
      (callerIdentity && identity === callerIdentity)
    ) {
      dispose();
    }
  };
  const onRoomDisconnected = (): void => {
    dispose();
  };
  room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  room.on(RoomEvent.Disconnected, onRoomDisconnected);

  const runLeg = async (identity: string, speaker: string): Promise<void> => {
    try {
      const participant = await waitForRemoteParticipant(room, identity);
      if (disposed) return;
      const track = await waitForAudioTrack(room, participant);
      if (disposed) return;

      const sttInstance = buildBridgeStt(
        agent,
        transcribe.language,
        organisationKeys,
      );
      const sttStream = sttInstance.stream();
      const audioStream = new AudioStream(track, {
        sampleRate: BRIDGE_STT_SAMPLE_RATE,
        numChannels: 1,
      });
      const stop = () => {
        try {
          sttStream.detachInputStream();
        } catch {
          /* not attached / already closed */
        }
        try {
          sttStream.close();
        } catch {
          /* already closed */
        }
        void sttInstance.close().catch(() => {});
        void (audioStream as unknown as ReadableStream<AudioFrame>)
          .cancel()
          .catch(() => {});
      };
      cleanups.push(stop);
      if (disposed) {
        // dispose() ran between the awaits above and the push — unwind now.
        stop();
        return;
      }
      sttStream.updateInputStream(
        audioStream as unknown as ReadableStream<AudioFrame>,
      );
      logger.info(
        { roomName, identity, speaker, label: sttInstance.label },
        "bridgedTransferTranscribe: STT stream armed for bridged leg",
      );
      for await (const ev of sttStream) {
        if (disposed) break;
        if (ev.type === stt.SpeechEventType.FINAL_TRANSCRIPT) {
          const text = ev.alternatives?.[0]?.text ?? "";
          if (text) await collector.add(speaker, text);
        }
      }
    } catch (e) {
      // Best-effort: a failed leg must not disturb the bridge, the other
      // leg's transcription, or the DTMF watch.
      if (!disposed) {
        logger.warn(
          { e, roomName, identity, speaker },
          "bridgedTransferTranscribe: leg transcription failed (continuing without it)",
        );
      }
    }
  };

  if (callerIdentity) {
    void runLeg(callerIdentity, CALLER);
  } else {
    logger.warn(
      { roomName },
      "bridgedTransferTranscribe: no caller identity; transcribing target leg only",
    );
  }
  void runLeg(targetIdentity, TARGET);

  logger.info(
    { roomName, callerIdentity, targetIdentity, language: transcribe.language, streamLog },
    "bridgedTransferTranscribe: bridged-segment transcription armed",
  );

  return { render: () => collector.render(), dispose };
}
