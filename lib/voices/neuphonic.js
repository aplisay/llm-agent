import speak from '../utils/speak.js';
import defaultLogger from '../logger.js';

export const NEUPHONIC_VOICES_URL = 'https://api.neuphonic.com/voices';
const FETCH_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 10 * 60 * 1000;

// Neuphonic gives each voice a bare language code; an accent tag, where present, picks the region.
const ACCENT_LOCALES = {
  en: { american: 'en-US', british: 'en-GB', scottish: 'en-GB', irish: 'en-IE', australian: 'en-AU', indian: 'en-IN' },
  es: { spanish: 'es-ES', castilian: 'es-ES', argentinian: 'es-AR', mexican: 'es-MX', colombian: 'es-CO', peruvian: 'es-PE', venezuelan: 'es-VE' },
  pt: { brazilian: 'pt-BR', portuguese: 'pt-PT' },
};
const GENDERS = { male: 'male', man: 'male', female: 'female', woman: 'female' };

/** `de` → `de-DE` (the most likely region). Unknown codes pass through unchanged. */
function defaultLocale(code) {
  try {
    const { language, region } = new Intl.Locale(code).maximize();
    return region ? `${language}-${region}` : language;
  } catch {
    return code;
  }
}

/**
 * One catalogue row per Neuphonic voice, in the shape the other lib/voices services use. `name` is the
 * voice id the workers send. Only stock voices: a cloned voice belongs to whoever cloned it.
 *
 * @param {object} response GET /voices body
 * @returns {{ name: string, description: string, gender?: string, language: string }[]}
 */
export function mapNeuphonicVoices(response) {
  const voices = Array.isArray(response?.data?.voices) ? response.data.voices : [];
  return voices
    .filter((v) => v?.voice_id && v?.lang_code && (!v.type || String(v.type).toLowerCase() === 'standard'))
    .map((v) => {
      const lang = String(v.lang_code).toLowerCase();
      const tags = Array.isArray(v.tags) ? v.tags.map((t) => String(t).trim()).filter(Boolean) : [];
      const gender = tags.map((t) => GENDERS[t.toLowerCase()]).find(Boolean);
      const accents = ACCENT_LOCALES[lang] || {};
      const language = tags.map((t) => accents[t.toLowerCase().replace(/\s+accent$/, '')]).find(Boolean)
        || defaultLocale(lang);
      const rest = tags.filter((t) => !GENDERS[t.toLowerCase()]);
      const label = String(v.name || v.voice_id).replace(/\s+/g, ' ').trim();
      return {
        name: v.voice_id,
        description: rest.length ? `${label} - ${rest.join(', ')}` : label,
        ...(gender ? { gender } : {}),
        language,
      };
    });
}

let cache = { at: 0, promise: null };

/** Forget the cached catalogue (tests). */
export function resetNeuphonicVoicesCache() {
  cache = { at: 0, promise: null };
}

/**
 * The mapped catalogue, fetched with the platform key and cached for ten minutes. A failed fetch is
 * not cached, so the next request retries.
 */
export async function fetchNeuphonicVoices({ fetchImpl = fetch, key = process.env.NEUPHONIC_API_KEY, logger = defaultLogger, now = Date.now } = {}) {
  if (!key) return [];
  if (cache.promise && now() - cache.at < CACHE_TTL_MS) return cache.promise;
  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(NEUPHONIC_VOICES_URL, { headers: { 'X-API-KEY': key }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return mapNeuphonicVoices(await res.json());
    } finally {
      clearTimeout(timer);
    }
  })();
  cache = { at: now(), promise };
  try {
    return await promise;
  } catch (err) {
    if (cache.promise === promise) resetNeuphonicVoicesCache();
    logger.error({ error: err?.message }, 'Neuphonic voice catalogue fetch failed');
    throw err;
  }
}

class Neuphonic {
  static name = 'neuphonic';
  static description = 'Neuphonic TTS';

  constructor(logger) {
    this.logger = logger.child({ neuphonicHelper: true });
  }

  get useSsml() {
    return false;
  }

  get speak() {
    return speak.text;
  }

  /**
   * Neuphonic voices as locale → voices.
   *
   * @param {string} [languageCode] keep only locales starting with this
   * @returns {Promise<Record<string, object[]>>}
   */
  async listVoices(languageCode) {
    try {
      const list = await fetchNeuphonicVoices({ logger: this.logger });
      return list
        .filter((voice) => !languageCode || voice.language.startsWith(languageCode))
        .reduce((o, { language, ...voice }) => ({ ...o, [language]: [...(o[language] || []), voice] }), {});
    } catch {
      return {};
    }
  }
}

export default Neuphonic;
