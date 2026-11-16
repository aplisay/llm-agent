/**
 * `formatted` and the Deepgram pass-through options on one STT block
 * (`options.stt`, `options.stt.aux` or `options.tts.output`): what each engine
 * is sent. See docs/stt-formatting.md. Keep the mapping in step with
 * agents/pipecat/pipecat_aplisay/stt_formatting.py.
 */
import logger from "./logger.js";

/** The formatting fields an STT block may carry (validated by the API at save time). */
export interface SttFormattingFields {
  formatted?: boolean;
  smart_format?: boolean;
  punctuate?: boolean;
  numerals?: boolean;
  no_delay?: boolean;
  endpointing?: number | false;
}

/** Deepgram query parameters, under Deepgram's own names. */
export interface DeepgramFormattingParams {
  smart_format?: boolean;
  punctuate?: boolean;
  numerals?: boolean;
  no_delay?: boolean;
  endpointing?: number | false;
}

// Callers read details out in pieces, and each pause ends a transcript that is formatted alone.
// The caller-side auxiliary engine is off the call path, so it can wait longer for a pause.
export const CALLER_DEEPGRAM_ENDPOINTING_MS = 1500;
export const CALLER_CARTESIA_MAX_SILENCE_SECS = 1.5;
/** The Deepgram plugin's AudioEnergyFilter stops sending audio this long after speech. */
export const DEEPGRAM_PLUGIN_SILENCE_CUTOFF_MS = 1000;

const DEEPGRAM_BOOLEANS = ["smart_format", "punctuate", "numerals", "no_delay"] as const;

/** Lenient copy of the formatting fields from an STT block: wrong types are dropped. */
export function pickSttFormatting(block: unknown): SttFormattingFields {
  if (!block || typeof block !== "object" || Array.isArray(block)) return {};
  const b = block as Record<string, unknown>;
  const out: SttFormattingFields = {};
  if (typeof b.formatted === "boolean") out.formatted = b.formatted;
  for (const field of DEEPGRAM_BOOLEANS) {
    if (typeof b[field] === "boolean") out[field] = b[field] as boolean;
  }
  if (b.endpointing === false || (Number.isInteger(b.endpointing) && (b.endpointing as number) > 0)) {
    out.endpointing = b.endpointing as number | false;
  }
  return out;
}

function hasDeepgramOptions(fields: SttFormattingFields): boolean {
  return DEEPGRAM_BOOLEANS.some((f) => fields[f] !== undefined) || fields.endpointing !== undefined;
}

/**
 * Deepgram parameters for a block: the `formatted` bundle, then any Deepgram
 * option set in the block on top. `longPause` is true for the caller-side
 * auxiliary engine only: the output engine gets audio only while the agent
 * speaks, so it never hears a long pause.
 */
export function deepgramFormatting(block: unknown, longPause: boolean): DeepgramFormattingParams {
  const fields = pickSttFormatting(block);
  const out: DeepgramFormattingParams = {};
  if (fields.formatted === true) {
    // No `numerals`: with smart_format it turns "half past seven" into "0.5 past 7".
    out.smart_format = true;
    out.punctuate = true;
    out.no_delay = true;
    if (longPause) out.endpointing = CALLER_DEEPGRAM_ENDPOINTING_MS;
  }
  for (const field of DEEPGRAM_BOOLEANS) {
    if (fields[field] !== undefined) out[field] = fields[field];
  }
  if (fields.endpointing !== undefined) out.endpointing = fields.endpointing;
  return out;
}

/** `vendor/model` without the `:lang` suffix, lowercased. */
function modelName(model: string): string {
  const idx = model.lastIndexOf(":");
  return (idx === -1 ? model : model.slice(0, idx)).trim().toLowerCase();
}

function warnIgnored(model: string, stage: string, why: string): void {
  logger.warn({ model, stage }, `${stage}: STT formatting options ignored (${why})`);
}

/** Flux models take none of the Deepgram formatting settings. */
function isDeepgramFlux(name: string): boolean {
  return /^deepgram\/flux/.test(name) || /^flux/.test(name);
}

/**
 * LiveKit Inference `modelOptions` for the resolved model string
 * (`deepgram/nova-3:en`, `assemblyai/universal-streaming:en`, ...).
 */
export function inferenceSttModelOptions(
  model: string,
  block: unknown,
  longPause: boolean,
  stage = "stt",
): Record<string, unknown> {
  const name = modelName(model);
  const fields = pickSttFormatting(block);
  if (name.startsWith("deepgram/")) {
    if (isDeepgramFlux(name)) {
      if (fields.formatted || hasDeepgramOptions(fields)) warnIgnored(model, stage, "Deepgram Flux has none of these settings");
      return {};
    }
    return { ...deepgramFormatting(block, longPause) };
  }
  if (hasDeepgramOptions(fields)) warnIgnored(model, stage, "Deepgram options on another engine");
  if (fields.formatted !== true) return {};
  // Universal-3.5/3.6 Pro always format; format_turns applies to Universal-Streaming only.
  if (name === "assemblyai/universal-streaming") return { format_turns: true };
  if (name === "cartesia/ink-whisper" && longPause) {
    return { max_silence_duration_secs: CALLER_CARTESIA_MAX_SILENCE_SECS };
  }
  return {};
}

/** Constructor options for `@livekit/agents-plugin-deepgram`'s STT, given the plugin model id. */
export function deepgramPluginFormatting(
  pluginModel: string,
  block: unknown,
  longPause: boolean,
  stage = "stt",
): { smartFormat?: boolean; punctuate?: boolean; numerals?: boolean; noDelay?: boolean; endpointing?: number | false } {
  const fields = pickSttFormatting(block);
  if (isDeepgramFlux(pluginModel.toLowerCase())) {
    if (fields.formatted || hasDeepgramOptions(fields)) warnIgnored(pluginModel, stage, "Deepgram Flux has none of these settings");
    return {};
  }
  const p = deepgramFormatting(block, longPause);
  return {
    ...(p.smart_format !== undefined ? { smartFormat: p.smart_format } : {}),
    ...(p.punctuate !== undefined ? { punctuate: p.punctuate } : {}),
    ...(p.numerals !== undefined ? { numerals: p.numerals } : {}),
    ...(p.no_delay !== undefined ? { noDelay: p.no_delay } : {}),
    ...(p.endpointing !== undefined ? { endpointing: p.endpointing } : {}),
  };
}

/** At teardown, how long a side engine with a long pause waits for its last final. */
export const SIDE_DRAIN_MS = 2000;

export interface SideEngineTiming {
  /** Create the stream with the Deepgram plugin's silence drop off (deepgram-send-all-audio.ts). */
  sendAllAudio: boolean;
  /** Flush when no frame at all has arrived for this long after speech (the plugin sends `Finalize`). */
  finalizeAfterIdleMs?: number;
  /** At teardown, end the input and wait up to this long for the last final. */
  drainMs?: number;
}

/**
 * How a side engine runs when its block asks for a long pause: `formatted` on the caller-side
 * engine, or an explicit Deepgram `endpointing` of 1000 ms or more. Otherwise as before.
 */
export function sideEngineTiming(engineLabel: string, block: unknown, longPause: boolean): SideEngineTiming {
  const { endpointing } = deepgramFormatting(block, longPause);
  const deepgramLong = typeof endpointing === "number" && endpointing >= DEEPGRAM_PLUGIN_SILENCE_CUTOFF_MS;
  if (!deepgramLong && !(longPause && pickSttFormatting(block).formatted === true)) return { sendAllAudio: false };
  // Above the plugin's 1 s silence drop its endpointing cannot fire unless it sends all audio.
  const plugin = engineLabel === "deepgram.STT" && deepgramLong;
  return {
    sendAllAudio: plugin,
    ...(plugin ? { finalizeAfterIdleMs: (endpointing as number) + 1000 } : {}),
    drainMs: SIDE_DRAIN_MS,
  };
}
