/**
 * Auxiliary ("second opinion") speech recognition — `options.stt.aux`.
 *
 * Runs a second, independent STT engine over the caller's audio alongside the
 * agent's own recognition (the pipeline STT, or a realtime model's built-in
 * transcription) and logs each final transcript it produces as a `user-aux`
 * transaction-log entry next to the primary `user` entry, so two recognitions
 * of the same speech can be compared. The auxiliary engine never feeds the
 * model — it is observation only.
 *
 * Mechanism: the worker already holds its own rtc-node connection to the room,
 * so this opens one extra {@link AudioStream} on the caller participant's audio
 * track — the technique bridge-transcription.ts uses for the bridged humans —
 * and pumps it into a fresh STT stream. The AgentSession and this stream consume
 * the same track independently; the session is untouched. STT vendor selection
 * reuses the pipeline resolution with `options.stt.aux` standing in for
 * `options.stt` (`inference.STT.fromModelString(resolvePipelineStt(...))`, or
 * the direct Deepgram plugin under LIVEKIT_PIPELINE_USE_PROVIDER_KEYS), so the
 * same vendor strings mean the same thing in both places.
 *
 * Metering: the audio streamed to the auxiliary engine is measured here in the
 * pump (milliseconds, silence included — the basis streaming STT vendors bill
 * on) and final transcripts are counted in characters. Both are reported through
 * `onUsage` and land as `stt-aux` usage rows attributed to the agent call — its
 * own technology, so the second engine's consumption is never merged with, or
 * gated like, the primary `stt` meter (realtime models bundle their own
 * recognition into the model charge; the auxiliary engine is a real extra cost).
 *
 * Everything here is best-effort: an auxiliary STT failure must never disturb
 * the call. The stream self-disposes when the caller leaves or the room
 * disconnects; the runtime disposes it on teardown, on a full agent handover
 * (re-arming for the incoming agent's own configuration) and when the agent's
 * media is detached after a bridged transfer.
 */

import { inference, stt } from "@livekit/agents";
import { AudioStream, RoomEvent } from "@livekit/rtc-node";
import type { AudioFrame, RemoteParticipant, Room, Track } from "@livekit/rtc-node";
import logger from "./logger.js";
import type { Agent } from "./api-client.js";
import { resolvePipelineStt } from "./pipeline-inference-options.js";
import {
  buildProviderPipelineStt,
  pipelineUsesProviderApiKeys,
} from "./pipeline-provider-keys.js";
import { fromServiceString, type VendorDetail } from "./usage-vendors.js";
import { waitForAudioTrack, waitForRemoteParticipant } from "./bridge-transcription.js";

/** Ledger technology for auxiliary-STT usage rows (distinct from the primary `stt`). */
export const AUX_STT_TECHNOLOGY = "stt-aux";
/** Transaction-log type for auxiliary transcripts (next to the primary `user`). */
export const AUX_STT_LOG_TYPE = "user-aux";
/** Sample rate the caller track is decoded at for the auxiliary stream. */
const AUX_STT_SAMPLE_RATE = 16000;
/** Report streamed-audio usage to the meter at least this often (ms of audio). */
const AUDIO_USAGE_REPORT_INTERVAL_MS = 10_000;

/** Normalised `options.stt.aux`: the same fields as `options.stt`. */
export interface AuxSttConfig {
  vendor?: string;
  language?: string;
}

/**
 * Normalise `options.stt.aux` to null (off) or `{vendor?, language?}`.
 * Lenient — the server validated the shape at save time. Absent / `false` /
 * `enabled: false` / malformed → off; `true` or `{}` → platform defaults.
 */
export function parseAuxSttOption(options: any): AuxSttConfig | null {
  const raw = options?.stt?.aux;
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return {};
  if (typeof raw !== "object" || Array.isArray(raw) || raw.enabled === false) {
    return null;
  }
  const vendor =
    typeof raw.vendor === "string" && raw.vendor.trim() ? raw.vendor.trim() : undefined;
  const language =
    typeof raw.language === "string" && raw.language.trim()
      ? raw.language.trim()
      : undefined;
  return { ...(vendor ? { vendor } : {}), ...(language ? { language } : {}) };
}

/**
 * The agent with `options.stt.aux` standing in for `options.stt`, so the
 * pipeline STT resolvers build the auxiliary engine exactly as they would the
 * primary one. Language falls back to the agent's own `stt.language`, then
 * `tts.language` (the platform's declare-once convention); the nested `aux`
 * block itself is dropped.
 */
export function auxSttAgent(agent: Agent, config: AuxSttConfig): Agent {
  const options: any = agent?.options || {};
  const inherited =
    (typeof options.stt?.language === "string" && options.stt.language.trim()) ||
    (typeof options.tts?.language === "string" && options.tts.language.trim()) ||
    undefined;
  const language = config.language ?? inherited;
  const sttBlock: Record<string, string> = {};
  if (config.vendor) sttBlock.vendor = config.vendor;
  if (language) sttBlock.language = language;
  return { ...agent, options: { ...options, stt: sttBlock } } as Agent;
}

/** Canonical billing `{vendor, detail}` for the auxiliary engine. */
export function resolveAuxSttVendor(agent: Agent, config: AuxSttConfig): VendorDetail {
  try {
    return fromServiceString(resolvePipelineStt(auxSttAgent(agent, config)));
  } catch {
    const vendor = config.vendor?.split("/")[0]?.split(":")[0]?.trim().toLowerCase();
    return vendor ? { vendor } : {};
  }
}

/**
 * A fresh STT instance for the auxiliary engine — the pipeline's own
 * resolution applied to `options.stt.aux`: LiveKit Inference by default, or
 * the direct Deepgram plugin under LIVEKIT_PIPELINE_USE_PROVIDER_KEYS.
 */
export function buildAuxStt(agent: Agent, config: AuxSttConfig): stt.STT {
  const effective = auxSttAgent(agent, config);
  if (pipelineUsesProviderApiKeys()) {
    return buildProviderPipelineStt(effective);
  }
  return inference.STT.fromModelString(resolvePipelineStt(effective));
}

/** Live auxiliary transcription: usage so far + teardown. */
export interface AuxSttHandle {
  /** Stop the audio pump and STT stream, reporting any unreported usage. Idempotent. */
  dispose(): void;
  /** Audio milliseconds streamed to the engine and characters it returned. */
  readonly usage: { milliseconds: number; characters: number };
}

/** Anything the pump can iterate for caller audio (the rtc-node AudioStream, or a test fake). */
export type AuxAudioSource = (AsyncIterable<AudioFrame> | { getReader(): any }) & {
  cancel?: () => Promise<unknown>;
};

export interface ArmAuxSttParams {
  /** The worker's connected RTC room (ctx.room). */
  room: Room;
  /** Server-side room name, for logging. */
  roomName: string;
  /** Identity of the caller participant whose audio is transcribed. */
  callerIdentity: string;
  /** The agent whose `options.stt.aux` (and language defaults) apply. */
  agent: Agent;
  config: AuxSttConfig;
  /** A final transcript from the auxiliary engine, with the time it arrived. */
  onTranscript: (text: string, at: Date) => void;
  /** A usage delta for the aux meter. */
  onUsage: (unit: "milliseconds" | "characters", quantity: number) => void;
  /** Injection points (tests): engine construction, track resolution, audio source. */
  deps?: {
    buildStt?: (agent: Agent, config: AuxSttConfig) => stt.STT;
    resolveTrack?: (room: Room, identity: string) => Promise<Track>;
    openAudioStream?: (track: Track) => AuxAudioSource;
  };
}

async function defaultResolveTrack(room: Room, identity: string): Promise<Track> {
  const participant = await waitForRemoteParticipant(room, identity);
  return waitForAudioTrack(room, participant);
}

function defaultOpenAudioStream(track: Track): AuxAudioSource {
  return new AudioStream(track, {
    sampleRate: AUX_STT_SAMPLE_RATE,
    numChannels: 1,
  }) as unknown as AuxAudioSource;
}

/** Iterate an audio source whether it is a web ReadableStream or a plain async iterable. */
async function* frames(source: AuxAudioSource): AsyncGenerator<AudioFrame> {
  if (typeof (source as any)[Symbol.asyncIterator] === "function") {
    for await (const frame of source as AsyncIterable<AudioFrame>) yield frame;
    return;
  }
  const reader = (source as { getReader(): any }).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value as AudioFrame;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/**
 * Arm the auxiliary STT on the caller's audio track. Resolves the participant
 * and track (waiting for them if needed), builds the engine, then pumps the
 * decoded audio into its stream while forwarding final transcripts and usage.
 * Never throws — transcription is best-effort.
 */
export function armAuxStt(params: ArmAuxSttParams): AuxSttHandle {
  const { room, roomName, callerIdentity, agent, config, onTranscript, onUsage } = params;
  const buildStt = params.deps?.buildStt ?? buildAuxStt;
  const resolveTrack = params.deps?.resolveTrack ?? defaultResolveTrack;
  const openAudioStream = params.deps?.openAudioStream ?? defaultOpenAudioStream;

  const usage = { milliseconds: 0, characters: 0 };
  let reportedMs = 0;
  let disposed = false;
  const cleanups: Array<() => void> = [];

  /** Report streamed audio not yet reported (whole milliseconds, no drift). */
  const reportAudio = (): void => {
    const delta = Math.floor(usage.milliseconds) - reportedMs;
    if (delta <= 0) return;
    reportedMs += delta;
    try {
      onUsage("milliseconds", delta);
    } catch (e) {
      logger.debug({ e, roomName }, "auxStt: usage report failed");
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.off(RoomEvent.Disconnected, onRoomDisconnected);
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch (e) {
        logger.debug({ e, roomName }, "auxStt: cleanup step failed");
      }
    }
    reportAudio();
    logger.info(
      { roomName, callerIdentity, ...usage },
      "auxStt: auxiliary transcription disposed",
    );
  };

  const onParticipantDisconnected = (p: RemoteParticipant): void => {
    const identity = p?.identity ?? (p as any)?.info?.identity;
    if (identity === callerIdentity) dispose();
  };
  const onRoomDisconnected = (): void => {
    dispose();
  };
  room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  room.on(RoomEvent.Disconnected, onRoomDisconnected);

  const run = async (): Promise<void> => {
    try {
      const track = await resolveTrack(room, callerIdentity);
      if (disposed) return;

      const sttInstance = buildStt(agent, config);
      const sttStream = sttInstance.stream();
      const audio = openAudioStream(track);
      const stop = () => {
        try {
          sttStream.endInput();
        } catch {
          /* already ended */
        }
        try {
          sttStream.close();
        } catch {
          /* already closed */
        }
        void sttInstance.close().catch(() => {});
        void audio.cancel?.().catch?.(() => {});
      };
      cleanups.push(stop);
      if (disposed) {
        // dispose() ran between the awaits above and the push — unwind now.
        stop();
        return;
      }

      // Pump the caller's audio into the engine ourselves (rather than handing
      // the stream over) so the audio actually streamed is what gets metered.
      const pump = (async (): Promise<void> => {
        try {
          for await (const frame of frames(audio)) {
            if (disposed) break;
            const rate = frame.sampleRate || AUX_STT_SAMPLE_RATE;
            usage.milliseconds += (frame.samplesPerChannel / rate) * 1000;
            try {
              sttStream.pushFrame(frame);
            } catch {
              break; // input ended underneath us (dispose / stream closed)
            }
            if (usage.milliseconds - reportedMs >= AUDIO_USAGE_REPORT_INTERVAL_MS) {
              reportAudio();
            }
          }
        } catch (e) {
          if (!disposed) {
            logger.warn({ e, roomName, callerIdentity }, "auxStt: audio pump failed");
          }
        } finally {
          try {
            sttStream.endInput();
          } catch {
            /* already ended */
          }
        }
      })();

      logger.info(
        { roomName, callerIdentity, label: sttInstance.label, config },
        "auxStt: auxiliary transcription armed on the caller track",
      );

      for await (const ev of sttStream) {
        if (disposed) break;
        if (ev.type !== stt.SpeechEventType.FINAL_TRANSCRIPT) continue;
        const text = (ev.alternatives?.[0]?.text ?? "").trim();
        if (!text) continue;
        usage.characters += text.length;
        try {
          onUsage("characters", text.length);
        } catch (e) {
          logger.debug({ e, roomName }, "auxStt: usage report failed");
        }
        try {
          onTranscript(text, new Date());
        } catch (e) {
          logger.warn({ e, roomName, callerIdentity }, "auxStt: transcript handler failed");
        }
      }
      await pump.catch(() => {});
    } catch (e) {
      // Best-effort: the call carries on without the second opinion.
      if (!disposed) {
        logger.warn(
          { e, roomName, callerIdentity },
          "auxStt: auxiliary transcription failed (continuing without it)",
        );
      }
    }
  };
  void run();

  return {
    dispose,
    get usage() {
      return usage;
    },
  };
}
