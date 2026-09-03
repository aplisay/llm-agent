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
  /**
   * Stop the audio pump, ask the engine to report its last usage interval, then
   * close it. Resolves once that report had its chance to land (bounded by
   * {@link USAGE_FLUSH_GRACE_MS}), so a caller that flushes meters right after
   * can await it. Idempotent.
   */
  dispose(): Promise<void>;
  /**
   * `milliseconds` = audio the engine reported accepting (what is metered);
   * `characters` = final transcript text; `streamedMilliseconds` = audio we
   * pumped at it (diagnostic only — it is not billed).
   */
  readonly usage: { milliseconds: number; characters: number; streamedMilliseconds: number };
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

  const usage = { milliseconds: 0, characters: 0, streamedMilliseconds: 0 };
  let disposed = false;
  let disposing: Promise<void> | null = null;
  const cleanups: Array<() => void> = [];
  /** Asks the live engine to report its last partial usage interval (set once the stream exists). */
  let flushUsageReport: (() => Promise<void>) | null = null;

  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    disposing = (async () => {
      disposed = true;
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.Disconnected, onRoomDisconnected);
      if (flushUsageReport) {
        try {
          await flushUsageReport();
        } catch {
          /* engine already gone */
        }
      }
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch (e) {
          logger.debug({ e, roomName }, "auxStt: cleanup step failed");
        }
      }
      if (usage.streamedMilliseconds > 0 && usage.milliseconds === 0) {
        logger.warn(
          { roomName, callerIdentity, ...usage },
          "auxStt: the engine accepted none of the streamed audio (connection or credentials failure?); nothing metered",
        );
      } else if (usage.streamedMilliseconds >= SILENT_ENGINE_WARN_MS && usage.characters === 0) {
        logger.warn(
          { roomName, callerIdentity, ...usage },
          "auxStt: the engine returned no transcript for the streamed audio",
        );
      }
      logger.info(
        { roomName, callerIdentity, ...usage },
        "auxStt: auxiliary transcription disposed",
      );
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
      const sttStream = sttInstance.stream();
      const audio = openAudioStream(track);

      // Meter what the ENGINE says it accepted, not what we pumped: both the
      // Inference stream and the Deepgram plugin report audio they actually sent
      // to the vendor (the plugin every 5 s, flushed on demand), and report
      // nothing while a connection is failing — so a 401 from the vendor cannot
      // become a bill for the caller.
      const onMetrics = (m: any): void => {
        const ms = Math.round(Number(m?.audioDurationMs) || 0);
        if (ms <= 0) return;
        usage.milliseconds += ms;
        try {
          onUsage("milliseconds", ms);
        } catch (e) {
          logger.debug({ e, roomName }, "auxStt: usage report failed");
        }
      };
      // The SDK surfaces engine failures as events, not throws (a failing
      // connection retries quietly for minutes): log them, and stop on a
      // non-recoverable one rather than keep pumping into a dead stream.
      const onEngineError = (ev: any): void => {
        const recoverable = ev?.recoverable !== false;
        logger.warn(
          { roomName, callerIdentity, label: ev?.label, recoverable, err: ev?.error?.message ?? String(ev?.error) },
          recoverable
            ? "auxStt: engine error (recoverable)"
            : "auxStt: engine failed (not recoverable); stopping the auxiliary transcription",
        );
        if (!recoverable) void dispose();
      };
      sttInstance.on("metrics_collected", onMetrics);
      sttInstance.on("error", onEngineError);
      flushUsageReport = async () => {
        sttStream.flush(); // FLUSH_SENTINEL → the engine reports its last partial usage interval
        await new Promise((resolve) => setTimeout(resolve, USAGE_FLUSH_GRACE_MS));
      };
      const stop = () => {
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
        void audio.cancel?.().catch?.(() => {});
      };
      cleanups.push(stop);
      if (disposed) {
        // dispose() ran between the awaits above and the push — unwind now.
        stop();
        return;
      }

      // Pump the caller's audio into the engine ourselves (rather than handing
      // the stream over) so we know how much we streamed — a diagnostic only;
      // the meter is the engine's own report above.
      const pump = (async (): Promise<void> => {
        try {
          for await (const frame of frames(audio)) {
            if (disposed) break;
            const rate = frame.sampleRate || AUX_STT_SAMPLE_RATE;
            usage.streamedMilliseconds += (frame.samplesPerChannel / rate) * 1000;
            try {
              sttStream.pushFrame(frame);
            } catch {
              break; // input ended underneath us (dispose / stream closed)
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
