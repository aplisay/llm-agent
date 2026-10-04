/**
 * Portable `options.tts.speed`: a multiplier on the vendor's normal speaking
 * rate (1.2 = 20% faster, 0.9 = 10% slower). 1, or unset, sends nothing, so the
 * vendor's own default survives. See docs/tts-speed.md.
 *
 * Each vendor accepts a narrower range than the API does, so the value is
 * clamped to the vendor's range here rather than refused at call time. Same
 * table as agents/pipecat/pipecat_aplisay/tts_speed.py.
 */
import type { Agent } from "./api-client.js";
import logger from "./logger.js";

/** [min, max] per vendor, as documented by the vendor. */
export const TTS_SPEED_RANGES: Record<string, [number, number]> = {
  elevenlabs: [0.7, 1.2],
  cartesia: [0.6, 1.5],
  deepgram: [0.7, 1.5],
  neuphonic: [0.7, 1.5],
  openai: [0.25, 1.5],
  xai: [0.7, 1.5],
};

/** The requested multiplier, or undefined when it is unset, 1, or not a positive number. */
export function requestedTtsSpeed(agent: Agent | null | undefined): number | undefined {
  const speed: unknown = agent?.options?.tts?.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0 || speed === 1) {
    return undefined;
  }
  return speed;
}

/** The requested speed clamped to `vendor`'s range, or undefined when there is none to send. */
export function ttsSpeedFor(agent: Agent | null | undefined, vendor: string): number | undefined {
  const speed = requestedTtsSpeed(agent);
  if (speed === undefined) return undefined;
  const range = TTS_SPEED_RANGES[vendor];
  if (!range) {
    logger.warn({ vendor, speed }, "options.tts.speed ignored: no speed control for this vendor");
    return undefined;
  }
  const clamped = Math.min(range[1], Math.max(range[0], speed));
  if (clamped !== speed) {
    logger.warn({ vendor, speed, clamped }, "options.tts.speed outside the vendor's range; clamped");
  }
  return clamped;
}

/**
 * The speed for Deepgram TTS `model`. Deepgram refuses the whole request (400) when an Aura-1 model
 * or an Aura-2 voice outside English and Spanish gets any speed, even 1, so those get none.
 */
export function deepgramTtsSpeed(agent: Agent | null | undefined, model: string): number | undefined {
  if (!/^aura-2-.+-(en|es)$/i.test(model)) {
    warnTtsSpeedUnsupported(agent, `deepgram ${model}`);
    return undefined;
  }
  return ttsSpeedFor(agent, "deepgram");
}

/** Log that `speed` was asked for but this path cannot send it. */
export function warnTtsSpeedUnsupported(agent: Agent | null | undefined, where: string): void {
  const speed = requestedTtsSpeed(agent);
  if (speed !== undefined) {
    logger.warn({ where, speed }, "options.tts.speed ignored: not supported here");
  }
}
