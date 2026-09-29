/**
 * Portable `options.tts.speed`: a multiplier on the vendor's normal speaking
 * rate (1.2 = 20% faster, 0.9 = 10% slower). 1, or unset, sends nothing.
 * See docs/tts-speed.md.
 *
 * The workers clamp to each vendor's range (agents/livekit/lib/tts-speed.ts,
 * agents/pipecat/pipecat_aplisay/tts_speed.py); the API only refuses values no
 * vendor accepts.
 */

/** The widest range any supported vendor accepts (Ultravox LMNT and Google voices). */
export const TTS_SPEED_MIN = 0.25;
export const TTS_SPEED_MAX = 2;

/**
 * Throw when `speed` is set but not a number in [TTS_SPEED_MIN, TTS_SPEED_MAX].
 *
 * @param {unknown} speed
 */
export function validateTtsSpeed(speed) {
  if (speed === undefined || speed === null) return;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < TTS_SPEED_MIN || speed > TTS_SPEED_MAX) {
    throw new Error(
      `options.tts.speed must be a number from ${TTS_SPEED_MIN} to ${TTS_SPEED_MAX} (1 = normal speed), got ${JSON.stringify(speed)}`
    );
  }
}

/**
 * The requested multiplier, or undefined when it is unset, 1, or not a positive number.
 *
 * @param {object} [options] agent options
 * @returns {number | undefined}
 */
export function requestedTtsSpeed(options) {
  const speed = options?.tts?.speed;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0 || speed === 1) return undefined;
  return speed;
}

// Ultravox provider -> voiceOverrides placement. Same table as the LiveKit
// plugin's voice_speed.ts and pipecat_aplisay/tts_speed.py.
const ULTRAVOX_SPEED_FIELDS = {
  eleven_labs: { key: 'elevenLabs', range: [0.7, 1.2], build: (speed) => ({ speed }) },
  cartesia: { key: 'cartesia', range: [0.6, 1.5], build: (speed) => ({ generationConfig: { speed } }) },
  lmnt: { key: 'lmnt', range: [0.25, 2], build: (speed) => ({ speed }) },
  google: { key: 'google', range: [0.25, 2], build: (speakingRate) => ({ speakingRate }) },
  inworld: { key: 'inworld', range: [0.5, 1.5], build: (speakingRate) => ({ speakingRate }) },
};

/**
 * Ultravox `voiceOverrides` for `speed` on a voice backed by `provider`, clamped
 * to that provider's range, or undefined when the provider has no speed field.
 *
 * @param {string | undefined} provider e.g. `eleven_labs`, `cartesia`
 * @param {number} speed
 * @returns {object | undefined}
 */
export function ultravoxSpeedOverrides(provider, speed) {
  const field = ULTRAVOX_SPEED_FIELDS[String(provider || '').toLowerCase()];
  if (!field) return undefined;
  const [min, max] = field.range;
  return { [field.key]: field.build(Math.min(max, Math.max(min, speed))) };
}
