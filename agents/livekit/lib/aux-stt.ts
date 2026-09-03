/**
 * Side STT engines: the auxiliary ("second opinion") recognition of the CALLER
 * (`options.stt.aux`, armed here) and the shared engine machinery the output
 * audit of the AGENT (`options.tts.output`, see output-stt.ts) also runs on.
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
 * Metering: milliseconds come from the engine's own usage report
 * (`metrics_collected` → `audioDurationMs`, the same event the primary STT
 * meter reads as `stt_metrics`), which both the LiveKit Inference stream and the
 * Deepgram plugin derive from the audio they actually SENT to the vendor — so
 * an engine that never connects (bad credentials, say) meters nothing, however
 * much audio we pumped at it. Final transcripts are counted in characters. Both
 * are reported through `onUsage` and land as `stt-aux` usage rows attributed to
 * the agent call — its own technology, so the second engine's consumption is
 * never merged with, or gated like, the primary `stt` meter (realtime models
 * bundle their own recognition into the model charge; the auxiliary engine is a
 * real extra cost). The audio we streamed is kept separately for diagnostics.
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
/**
 * On dispose, how long to give the engine to report its last partial usage
 * interval after we ask it to flush, before the stream is closed for good.
 */
const USAGE_FLUSH_GRACE_MS = 300;
/** Streamed audio below which "the engine returned nothing" is not worth a warning. */
const SILENT_ENGINE_WARN_MS = 3000;

/** Normalised side-STT block: the same fields as `options.stt`. */
export interface SideSttConfig {
  vendor?: string;
  language?: string;
}
/** @deprecated alias — the caller-side name. */
export type AuxSttConfig = SideSttConfig;

/** Which of the agent's own language declarations a side engine inherits, in order. */
export type LanguageSource = "stt" | "tts";
/** The caller side speaks the language the agent listens for. */
const AUX_LANGUAGE_ORDER: LanguageSource[] = ["stt", "tts"];
/** The agent side speaks in its TTS language. */
const OUTPUT_LANGUAGE_ORDER: LanguageSource[] = ["tts", "stt"];

/**
 * Normalise one side-STT block to null (off) or `{vendor?, language?}`.
 * Lenient — the server validated the shape at save time. Absent / `false` /
 * `enabled: false` / malformed → off; `true` or `{}` → platform defaults.
 */
export function parseSideSttBlock(raw: unknown): SideSttConfig | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return {};
  if (typeof raw !== "object" || Array.isArray(raw) || (raw as any).enabled === false) {
    return null;
  }
  const block = raw as Record<string, unknown>;
  const vendor =
    typeof block.vendor === "string" && block.vendor.trim() ? block.vendor.trim() : undefined;
  const language =
    typeof block.language === "string" && block.language.trim()
      ? block.language.trim()
      : undefined;
  return { ...(vendor ? { vendor } : {}), ...(language ? { language } : {}) };
}

/** `options.stt.aux` → config or null (off). */
export function parseAuxSttOption(options: any): SideSttConfig | null {
  return parseSideSttBlock(options?.stt?.aux);
}

/** `options.tts.output` → config or null (off). */
export function parseOutputSttOption(options: any): SideSttConfig | null {
  return parseSideSttBlock(options?.tts?.output);
}

/**
 * The agent with a side block standing in for `options.stt`, so the pipeline
 * STT resolvers build the side engine exactly as they would the primary one.
 * Language falls back through `order` (the platform's declare-once
 * convention); the nested side blocks themselves are dropped.
 */
export function sideSttAgent(agent: Agent, config: SideSttConfig, order: LanguageSource[]): Agent {
  const options: any = agent?.options || {};
  let language = config.language;
  for (const source of order) {
    if (language) break;
    const declared = options[source]?.language;
    language = typeof declared === "string" && declared.trim() ? declared.trim() : undefined;
  }
  const sttBlock: Record<string, string> = {};
  if (config.vendor) sttBlock.vendor = config.vendor;
  if (language) sttBlock.language = language;
  return { ...agent, options: { ...options, stt: sttBlock } } as Agent;
}

export function auxSttAgent(agent: Agent, config: SideSttConfig): Agent {
  return sideSttAgent(agent, config, AUX_LANGUAGE_ORDER);
}

export function outputSttAgent(agent: Agent, config: SideSttConfig): Agent {
  return sideSttAgent(agent, config, OUTPUT_LANGUAGE_ORDER);
}

/** Canonical billing `{vendor, detail}` for a side engine. */
export function resolveSideSttVendor(
  agent: Agent,
  config: SideSttConfig,
  order: LanguageSource[],
): VendorDetail {
  try {
    return fromServiceString(resolvePipelineStt(sideSttAgent(agent, config, order)));
  } catch {
    const vendor = config.vendor?.split("/")[0]?.split(":")[0]?.trim().toLowerCase();
    return vendor ? { vendor } : {};
  }
}

export function resolveAuxSttVendor(agent: Agent, config: SideSttConfig): VendorDetail {
  return resolveSideSttVendor(agent, config, AUX_LANGUAGE_ORDER);
}

export function resolveOutputSttVendor(agent: Agent, config: SideSttConfig): VendorDetail {
  return resolveSideSttVendor(agent, config, OUTPUT_LANGUAGE_ORDER);
}

/**
 * A fresh STT instance for a side engine — the pipeline's own resolution
 * applied to the side block: LiveKit Inference by default, or the direct
 * Deepgram plugin under LIVEKIT_PIPELINE_USE_PROVIDER_KEYS.
 */
export function buildSideStt(agent: Agent, config: SideSttConfig, order: LanguageSource[]): stt.STT {
  const effective = sideSttAgent(agent, config, order);
  if (pipelineUsesProviderApiKeys()) {
    return buildProviderPipelineStt(effective);
  }
  return inference.STT.fromModelString(resolvePipelineStt(effective));
}

export function buildAuxStt(agent: Agent, config: SideSttConfig): stt.STT {
  return buildSideStt(agent, config, AUX_LANGUAGE_ORDER);
}

export function buildOutputStt(agent: Agent, config: SideSttConfig): stt.STT {
  return buildSideStt(agent, config, OUTPUT_LANGUAGE_ORDER);
}

/** Usage counters shared by both sides. */
export interface SideSttUsage {
  /** Audio the engine reported accepting — what is metered. */
  milliseconds: number;
  /** Final transcript text the engine returned. */
  characters: number;
  /** Audio we handed to the engine (diagnostic only — never billed). */
  streamedMilliseconds: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A running side STT engine fed frame by frame. */
export interface SideSttEngine {
  /** Feed one audio frame; a no-op once the engine is disposed or has failed. */
  push(frame: AudioFrame): void;
  /**
   * Ask the engine to report its last usage interval, then close it. Resolves
   * once that report had its chance to land (bounded by
   * {@link USAGE_FLUSH_GRACE_MS}). Idempotent.
   */
  dispose(): Promise<void>;
  readonly usage: SideSttUsage;
}

export interface StartSideSttEngineParams {
  /** Log prefix: `auxStt` (caller side) or `outputStt` (agent side). */
  label: string;
  roomName: string;
  /** What is being transcribed, for logs (a caller identity, "agent output"). */
  subject: string;
  /** The engine, already built (so a build failure is the caller's to handle). */
  stt: stt.STT;
  /** A final transcript, with the time it arrived. */
  onTranscript: (text: string, at: Date) => void;
  /** A usage delta for the side meter. */
  onUsage: (unit: "milliseconds" | "characters", quantity: number) => void;
  /** Invoked when the engine stops itself on a non-recoverable error. */
  onEngineStopped?: () => void;
}

/**
 * Run a side STT engine: consume its stream (finals → `onTranscript`, the
 * engine's own audio-usage reports → `onUsage`, errors → logged; a
 * non-recoverable one stops the engine), and expose `push` for whoever holds
 * the audio — the caller-track pump below, or the output tee. Both sides meter
 * what the ENGINE says it accepted, never what was pushed: the Inference
 * stream and the Deepgram plugin report audio they actually sent to the vendor
 * (the plugin every 5 s, flushed on demand) and nothing while a connection is
 * failing, so a rejected credential cannot become a bill.
 */
export function startSideSttEngine(params: StartSideSttEngineParams): SideSttEngine {
  const { label, roomName, subject, stt: sttInstance, onTranscript, onUsage, onEngineStopped } = params;
  const usage: SideSttUsage = { milliseconds: 0, characters: 0, streamedMilliseconds: 0 };
  let disposed = false;
  let disposing: Promise<void> | null = null;
  const sttStream = sttInstance.stream();

  const onMetrics = (m: any): void => {
    const ms = Math.round(Number(m?.audioDurationMs) || 0);
    if (ms <= 0) return;
    usage.milliseconds += ms;
    try {
      onUsage("milliseconds", ms);
    } catch (e) {
      logger.debug({ e, roomName }, `${label}: usage report failed`);
    }
  };
  const onEngineError = (ev: any): void => {
    const recoverable = ev?.recoverable !== false;
    logger.warn(
      { roomName, subject, label: ev?.label, recoverable, err: ev?.error?.message ?? String(ev?.error) },
      recoverable
        ? `${label}: engine error (recoverable)`
        : `${label}: engine failed (not recoverable); stopping the side transcription`,
    );
    if (!recoverable) {
      void dispose();
      try {
        onEngineStopped?.();
      } catch {
        /* best-effort */
      }
    }
  };
  sttInstance.on("metrics_collected", onMetrics);
  sttInstance.on("error", onEngineError);

  const consumer = (async (): Promise<void> => {
    try {
      for await (const ev of sttStream) {
        if (disposed) break;
        if (ev.type !== stt.SpeechEventType.FINAL_TRANSCRIPT) continue;
        const text = (ev.alternatives?.[0]?.text ?? "").trim();
        if (!text) continue;
        usage.characters += text.length;
        try {
          onUsage("characters", text.length);
        } catch (e) {
          logger.debug({ e, roomName }, `${label}: usage report failed`);
        }
        try {
          onTranscript(text, new Date());
        } catch (e) {
          logger.warn({ e, roomName, subject }, `${label}: transcript handler failed`);
        }
      }
    } catch (e) {
      if (!disposed) {
        logger.warn({ e, roomName, subject }, `${label}: side transcription failed (continuing without it)`);
      }
    }
  })();

  const push = (frame: AudioFrame): void => {
    if (disposed) return;
    const rate = frame.sampleRate || AUX_STT_SAMPLE_RATE;
    usage.streamedMilliseconds += (frame.samplesPerChannel / rate) * 1000;
    try {
      sttStream.pushFrame(frame);
    } catch {
      /* input ended underneath us (dispose / stream closed) */
    }
  };

  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    disposing = (async () => {
      disposed = true;
      try {
        sttStream.flush(); // FLUSH_SENTINEL → the engine reports its last partial usage interval
        await sleep(USAGE_FLUSH_GRACE_MS);
      } catch {
        /* engine already gone */
      }
      try {
        sttInstance.off("metrics_collected", onMetrics);
        sttInstance.off("error", onEngineError);
      } catch {
        /* not an emitter (tests) */
      }
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
      await consumer.catch(() => {});
      if (usage.streamedMilliseconds > 0 && usage.milliseconds === 0) {
        logger.warn(
          { roomName, subject, ...usage },
          `${label}: the engine accepted none of the streamed audio (connection or credentials failure?); nothing metered`,
        );
      } else if (usage.streamedMilliseconds >= SILENT_ENGINE_WARN_MS && usage.characters === 0) {
        logger.warn({ roomName, subject, ...usage }, `${label}: the engine returned no transcript for the streamed audio`);
      }
      logger.info({ roomName, subject, ...usage }, `${label}: side transcription disposed`);
    })();
    return disposing;
  };

  return {
    push,
    dispose,
    get usage() {
      return usage;
    },
  };
}

/** Live auxiliary (caller-side) transcription: usage so far + teardown. */
export interface AuxSttHandle {
  /** Stop the pump, let the engine report its last usage interval, close it. Idempotent. */
  dispose(): Promise<void>;
  readonly usage: SideSttUsage;
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
  config: SideSttConfig;
  /** A final transcript from the auxiliary engine, with the time it arrived. */
  onTranscript: (text: string, at: Date) => void;
  /** A usage delta for the aux meter. */
  onUsage: (unit: "milliseconds" | "characters", quantity: number) => void;
  /** Injection points (tests): engine construction, track resolution, audio source. */
  deps?: {
    buildStt?: (agent: Agent, config: SideSttConfig) => stt.STT;
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

const NO_USAGE: SideSttUsage = { milliseconds: 0, characters: 0, streamedMilliseconds: 0 };

/**
 * Arm the auxiliary STT on the caller's audio track. Resolves the participant
 * and track (waiting for them if needed), opens one more in-process sink on
 * the track the session already receives (an rtc-node AudioStream — at the
 * FFI layer a sink on the one decoded WebRTC track, not a new subscription),
 * builds the engine and pumps the decoded audio into it. Never throws.
 */
export function armAuxStt(params: ArmAuxSttParams): AuxSttHandle {
  const { room, roomName, callerIdentity, agent, config, onTranscript, onUsage } = params;
  const buildStt = params.deps?.buildStt ?? buildAuxStt;
  const resolveTrack = params.deps?.resolveTrack ?? defaultResolveTrack;
  const openAudioStream = params.deps?.openAudioStream ?? defaultOpenAudioStream;

  let engine: SideSttEngine | null = null;
  let disposed = false;
  let disposing: Promise<void> | null = null;
  const cleanups: Array<() => void> = [];

  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    disposing = (async () => {
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
      if (engine) await engine.dispose();
      logger.info({ roomName, callerIdentity, ...(engine?.usage ?? NO_USAGE) }, "auxStt: auxiliary transcription disposed");
    })();
    return disposing;
  };

  const onParticipantDisconnected = (p: RemoteParticipant): void => {
    const identity = p?.identity ?? (p as any)?.info?.identity;
    if (identity === callerIdentity) void dispose();
  };
  const onRoomDisconnected = (): void => {
    void dispose();
  };
  room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  room.on(RoomEvent.Disconnected, onRoomDisconnected);

  const run = async (): Promise<void> => {
    try {
      const track = await resolveTrack(room, callerIdentity);
      if (disposed) return;
      const sttInstance = buildStt(agent, config);
      engine = startSideSttEngine({
        label: "auxStt",
        roomName,
        subject: callerIdentity,
        stt: sttInstance,
        onTranscript,
        onUsage,
        onEngineStopped: () => void dispose(),
      });
      const audio = openAudioStream(track);
      cleanups.push(() => {
        void audio.cancel?.().catch?.(() => {});
      });
      if (disposed) {
        // dispose() ran between the awaits above and the push — unwind now.
        await engine.dispose();
        return;
      }
      logger.info(
        { roomName, callerIdentity, label: sttInstance.label, config },
        "auxStt: auxiliary transcription armed on the caller track",
      );
      // Pump the caller's audio into the engine ourselves (rather than handing
      // the stream over) so we know how much we streamed — a diagnostic only.
      for await (const frame of frames(audio)) {
        if (disposed) break;
        engine.push(frame);
      }
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
      return engine?.usage ?? NO_USAGE;
    },
  };
}
