/**
 * The xAI voice catalogue (docs/grok.md).
 *
 * The Grok voice model and xAI's TTS share one set of voices, listed by
 * `GET https://api.x.ai/v1/tts/voices`. `lib/models/xai.js` fetches that list
 * once with the platform key and maps it through `mapXaiVoices`; when the
 * fetch fails or no key is set it publishes `XAI_FALLBACK_VOICES` instead.
 * Every voice is multilingual, so the block sits under the `any` locale like
 * the other realtime catalogues. Names are the ids the realtime session takes
 * in `voice`; xAI matches them case-insensitively.
 *
 * Not a lib/voices catalogue service (those enumerate discrete TTS engines):
 * the voice handlers merge this block the way they merge the Ultravox one.
 */

export const XAI_DEFAULT_VOICE = 'eve';

/** Vendor key the block is published under. */
export const XAI_VENDOR = 'xAI';

export const XAI_VOICES_URL = 'https://api.x.ai/v1/tts/voices';

/**
 * @typedef {{ name: string, description: string, gender: 'male' | 'female' | 'unknown' }} VoiceRow
 */

const voice = (name, gender, extra = '') => ({
  name,
  description: `${name[0].toUpperCase()}${name.slice(1)} (multilingual${extra})`,
  gender,
});

/**
 * The built-in voices, as the catalogue endpoint listed them on 2026-09-16.
 * Used when no key is set or the endpoint cannot be read. Genders are xAI's
 * own labels from the endpoint.
 *
 * @type {VoiceRow[]}
 */
export const XAI_FALLBACK_VOICES = [
  voice('ara', 'female'),
  voice('eve', 'female', ', the default voice'),
  voice('leo', 'male'),
  voice('rex', 'male'),
  voice('sal', 'male'),
  voice('carina', 'female'),
  voice('zagan', 'male'),
  voice('helix', 'male'),
  voice('orion', 'male'),
  voice('luna', 'female'),
  voice('iris', 'female'),
  voice('altair', 'male'),
  voice('zenith', 'male'),
  voice('perseus', 'male'),
  voice('helios', 'male'),
  voice('lux', 'male'),
  voice('kepler', 'male'),
  voice('rigel', 'male'),
  voice('cosmo', 'male'),
  voice('celeste', 'female'),
  voice('ursa', 'female'),
  voice('sirius', 'male'),
  voice('lumen', 'male'),
  voice('castor', 'male'),
  voice('naksh', 'male'),
  voice('atlas', 'male'),
  voice('aurora', 'female'),
  voice('liora', 'female'),
];

/**
 * Map the catalogue endpoint's body (`{ voices: [{ voice_id, name, language,
 * gender }] }`, or a bare array of those entries) to catalogue rows. Entries
 * without a string `voice_id` are dropped.
 *
 * @param {unknown} body
 * @returns {VoiceRow[]}
 */
export function mapXaiVoices(body) {
  const entries = Array.isArray(body) ? body : (body && Array.isArray(body.voices) ? body.voices : []);
  return entries
    .filter((entry) => entry && typeof entry.voice_id === 'string' && entry.voice_id.trim())
    .map((entry) => {
      const name = entry.voice_id.trim();
      const gender = String(entry.gender || '').toLowerCase();
      const label = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : name;
      const language = typeof entry.language === 'string' && entry.language.trim() ? entry.language.trim() : 'multilingual';
      return {
        name,
        description: `${label} (${language}${name === XAI_DEFAULT_VOICE ? ', the default voice' : ''})`,
        gender: gender === 'male' || gender === 'female' ? gender : 'unknown',
      };
    });
}

/**
 * The xAI block in the `vendor → locale → voices[]` shape the model voice
 * helpers consume. A fresh copy each call so callers may mutate it.
 *
 * @param {VoiceRow[]} [rows]
 * @returns {Record<string, Record<string, VoiceRow[]>>}
 */
export function xaiVoiceTree(rows = XAI_FALLBACK_VOICES) {
  return { [XAI_VENDOR]: { any: rows.map((v) => ({ ...v })) } };
}

export default XAI_FALLBACK_VOICES;
