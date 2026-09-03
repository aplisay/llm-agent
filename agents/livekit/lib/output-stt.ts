/**
 * Output audit speech recognition — `options.tts.output`.
 *
 * Runs an independent STT engine over the AGENT's own audio — what the caller
 * actually hears, whether synthesised by the pipeline TTS or produced by a
 * realtime model — and logs each final transcript it produces as an
 * `agent-speech` transaction-log entry beside the `agent` entry the model
 * produced: an audit of what the agent said against what it thought it said.
 * Observation only; nothing here can affect the call.
 *
 * Mechanism: the agent's outbound audio is a stream of frames this process
 * itself produces and hands to the session's audio output, so the audit is a
 * tee at that point — the same construction the SDK's own RecorderIO uses to
 * record the agent. `session.output.audio` is replaced by a Proxy over the
 * live output object that intercepts ONLY `captureFrame` (copying each frame
 * to the side engine before forwarding it) and leaves every other member —
 * flush/clearBuffer/pause/resume, playback events, waitForPlayout — bound to
 * the original. Nothing touches the room: no subscription, no second media
 * stream, no FFI sink. (The SDK does not export its AudioOutput base class at
 * runtime, which is why this wraps an instance rather than subclassing.)
 *
 * Nothing is installed on a call unless `options.tts.output` is set — see the
 * runtime's armOutputSttFor, which returns before touching the session when the
 * option is absent. Metering is the engine's own audio-usage report, exactly as
 * for the caller side (see aux-stt.ts startSideSttEngine).
 */

import type { stt } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import logger from "./logger.js";
import type { Agent } from "./api-client.js";
import {
  buildOutputStt,
  startSideSttEngine,
  type SideSttConfig,
  type SideSttEngine,
  type SideSttUsage,
} from "./aux-stt.js";

/** Ledger technology for output-audit usage rows. */
export const OUTPUT_STT_TECHNOLOGY = "stt-output";
/** Transaction-log type for the output audit's transcripts (next to `agent`). */
export const OUTPUT_STT_LOG_TYPE = "agent-speech";

/** The one member of the SDK's AudioOutput the tee intercepts; the rest pass through. */
export interface TeeableAudioOutput {
  captureFrame(frame: AudioFrame): Promise<void>;
}

/** The slice of voice.AgentSession the tee needs (structural, so tests can fake it). */
export interface TeeableSession {
  output: { audio: TeeableAudioOutput | null };
}

export interface OutputSttHandle {
  /** Uninstall the tee (restoring the original output if still ours) and dispose the engine. Idempotent. */
  dispose(): Promise<void>;
  readonly usage: SideSttUsage;
  /** Whether a tee was actually installed (false when the session had no audio output or the engine could not be built). */
  readonly installed: boolean;
}

export interface ArmOutputSttParams {
  session: TeeableSession;
  roomName: string;
  agent: Agent;
  config: SideSttConfig;
  onTranscript: (text: string, at: Date) => void;
  onUsage: (unit: "milliseconds" | "characters", quantity: number) => void;
  deps?: {
    buildStt?: (agent: Agent, config: SideSttConfig) => stt.STT;
  };
}

const NO_USAGE: SideSttUsage = { milliseconds: 0, characters: 0, streamedMilliseconds: 0 };
const NOOP_HANDLE: OutputSttHandle = { dispose: async () => {}, usage: NO_USAGE, installed: false };

/**
 * Wrap a live audio output so every captured frame is also pushed to `engine`.
 * Exported for tests. Everything but `captureFrame` is the original's own
 * member, bound to the original, so the session cannot tell the difference.
 */
export function teeAudioOutput<T extends TeeableAudioOutput>(original: T, engine: SideSttEngine): T {
  return new Proxy(original, {
    get(target, prop) {
      if (prop === "captureFrame") {
        return async (frame: AudioFrame): Promise<void> => {
          engine.push(frame);
          return target.captureFrame(frame);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });
}

/**
 * Arm the output audit on a started session. Builds the engine, installs the
 * tee as `session.output.audio`, and returns a handle that restores the
 * original output on dispose. Never throws: a session without an audio
 * output, or an engine that cannot be built, leaves the session untouched.
 */
export function armOutputStt(params: ArmOutputSttParams): OutputSttHandle {
  const { session, roomName, agent, config, onTranscript, onUsage } = params;
  const buildStt = params.deps?.buildStt ?? buildOutputStt;

  const original = session.output.audio;
  if (!original) {
    logger.warn({ roomName }, "outputStt: session has no audio output to tee; skipping the output audit");
    return NOOP_HANDLE;
  }
  let sttInstance: stt.STT;
  try {
    sttInstance = buildStt(agent, config);
  } catch (e) {
    logger.warn({ e, roomName, config }, "outputStt: could not build the audit engine (continuing without it)");
    return NOOP_HANDLE;
  }

  let disposing: Promise<void> | null = null;
  let tee: TeeableAudioOutput | null = null;
  const dispose = (): Promise<void> => {
    if (disposing) return disposing;
    disposing = (async () => {
      if (tee && session.output.audio === tee) {
        try {
          session.output.audio = original;
        } catch (e) {
          logger.debug({ e, roomName }, "outputStt: could not restore the original audio output");
        }
      }
      await engine.dispose();
      logger.info({ roomName, ...engine.usage }, "outputStt: output audit disposed");
    })();
    return disposing;
  };

  const engine = startSideSttEngine({
    label: "outputStt",
    roomName,
    subject: "agent output",
    stt: sttInstance,
    onTranscript,
    onUsage,
    onEngineStopped: () => void dispose(),
  });
  tee = teeAudioOutput(original, engine);
  session.output.audio = tee;
  logger.info(
    { roomName, label: sttInstance.label, config, output: (original as any)?.constructor?.name },
    "outputStt: output audit armed on the session's audio output",
  );

  return {
    dispose,
    get usage() {
      return engine.usage;
    },
    installed: true,
  };
}
