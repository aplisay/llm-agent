/**
 * Save-time validation of `options.backgroundAudio`. See docs/background-audio.md.
 *
 * No imports, so code that must run without a database can use it. The workers
 * parse the same shape, with clamps in place of errors:
 * agents/livekit/lib/background-audio.ts and
 * agents/pipecat/pipecat_aplisay/background_audio.py. Keep the three in step.
 *
 * @module lib/background-audio-options
 */

export const BACKGROUND_AUDIO_SOUNDS = ['office'];
export const BACKGROUND_AUDIO_VOLUMES = ['low', 'medium', 'high'];
export const BACKGROUND_AUDIO_WHEN = ['thinking', 'silent', 'always'];
export const BACKGROUND_AUDIO_MAX_DELAY_MS = 10000;

const ENUMS = {
  sound: BACKGROUND_AUDIO_SOUNDS,
  volume: BACKGROUND_AUDIO_VOLUMES,
  when: BACKGROUND_AUDIO_WHEN,
};

/**
 * Throws an Error that names the bad field. Returns nothing when the value is
 * acceptable. `undefined` and `null` mean the option is not set.
 *
 * @param {unknown} value the agent's `options.backgroundAudio`
 */
export function validateBackgroundAudio(value) {
  if (value === undefined || value === null || value === true || value === false) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('options.backgroundAudio must be a boolean or an object');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('options.backgroundAudio.enabled must be a boolean');
  }
  for (const [field, allowed] of Object.entries(ENUMS)) {
    const given = value[field];
    if (given === undefined) continue;
    if (!allowed.includes(given)) {
      throw new Error(
        `options.backgroundAudio.${field} must be one of ${allowed.map((v) => `'${v}'`).join(', ')}`);
    }
  }
  const { delayMs } = value;
  if (delayMs !== undefined
    && (typeof delayMs !== 'number' || !Number.isFinite(delayMs)
      || delayMs < 0 || delayMs > BACKGROUND_AUDIO_MAX_DELAY_MS)) {
    throw new Error(
      `options.backgroundAudio.delayMs must be a number between 0 and ${BACKGROUND_AUDIO_MAX_DELAY_MS}`);
  }
}
