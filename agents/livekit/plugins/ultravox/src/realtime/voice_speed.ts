// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Portable `options.tts.speed` (a multiplier, 1 = normal) as Ultravox `voiceOverrides`.
 *
 * Ultravox has no call-level speed. The field sits under the provider that backs
 * the chosen voice, and the override must name that provider, so the caller looks
 * the provider up first (UltravoxClient.voiceProvider). Same table as
 * `ultravoxSpeedOverrides` in lib/tts-speed.js and pipecat_aplisay/tts_speed.py.
 * See https://docs.ultravox.ai/api-reference/calls/calls-post (voiceOverrides).
 */
const SPEED_FIELDS: Record<string, { key: string; range: [number, number]; build: (s: number) => unknown }> = {
  eleven_labs: { key: "elevenLabs", range: [0.7, 1.2], build: (speed) => ({ speed }) },
  cartesia: { key: "cartesia", range: [0.6, 1.5], build: (speed) => ({ generationConfig: { speed } }) },
  lmnt: { key: "lmnt", range: [0.25, 2], build: (speed) => ({ speed }) },
  google: { key: "google", range: [0.25, 2], build: (speakingRate) => ({ speakingRate }) },
  inworld: { key: "inworld", range: [0.5, 1.5], build: (speakingRate) => ({ speakingRate }) },
};

export interface UltravoxSpeedOverrides {
  voiceOverrides: Record<string, unknown>;
  /** The speed sent, after clamping to the provider's range. */
  speed: number;
}

/** Undefined when the provider has no speed field (e.g. respeecher) or is unknown. */
export function ultravoxSpeedOverrides(
  provider: string | undefined,
  speed: number,
): UltravoxSpeedOverrides | undefined {
  const field = provider ? SPEED_FIELDS[provider.toLowerCase()] : undefined;
  if (!field) return undefined;
  const [min, max] = field.range;
  const clamped = Math.min(max, Math.max(min, speed));
  return { voiceOverrides: { [field.key]: field.build(clamped) }, speed: clamped };
}
