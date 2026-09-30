import speak from '../utils/speak.js';
import defaultLogger from '../logger.js';

export const CARTESIA_VOICES_URL = 'https://api.cartesia.ai/voices';
export const CARTESIA_VERSION = '2025-04-16';
const PAGE_SIZE = 100;
// About 1,000 stock voices (11 pages) on 2026-09-30; the cap only stops a runaway cursor.
const MAX_PAGES = 50;
const FETCH_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const GENDERS = { feminine: 'female', masculine: 'male' };

// Languages `sonic-3` (the model both workers use) accepts, checked against /tts/bytes on 2026-09-30.
// Only `sonic-3-latest` speaks the `or` and `ur` voices, so they are left out. Keep in step with
// SONIC_3_LANGUAGES in agents/livekit/lib/pipeline-provider-keys.ts.
export const SONIC_3_LANGUAGES = new Set([
  'ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'gu', 'he', 'hi', 'hr', 'hu', 'id',
  'it', 'ja', 'ka', 'kn', 'ko', 'ml', 'mr', 'ms', 'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv',
  'ta', 'te', 'th', 'tl', 'tr', 'uk', 'vi', 'zh',
]);

/** `de` → `de-DE` (the most likely region). Unknown codes pass through unchanged. */
function defaultLocale(code) {
  try {
    const { language, region } = new Intl.Locale(code).maximize();
    return region ? `${language}-${region}` : language;
  } catch {
    return code;
  }
}

/** The voice's own accent locale, else language + country, else the language's likely region. */
function voiceLocale(v) {
  const native = (Array.isArray(v.accents) ? v.accents : []).find((a) => a?.is_native && a?.locale);
  if (native) return String(native.locale);
  const lang = String(v.language).toLowerCase();
  return v.country ? `${lang}-${String(v.country).toUpperCase()}` : defaultLocale(lang);
}

/**
 * One catalogue row per Cartesia voice, in the shape the other lib/voices services use. `name` is the
 * voice id the workers send. Only stock (public) voices, since a cloned voice belongs to whoever cloned it,
 * and only languages `sonic-3` can speak.
 *
 * @param {object[]} voices `data` rows from GET /voices, all pages
 * @returns {{ name: string, description: string, gender?: string, language: string }[]}
 */
export function mapCartesiaVoices(voices) {
  return (Array.isArray(voices) ? voices : [])
    .filter((v) => v?.id && v?.language && v.is_public === true && (!v.status || v.status === 'active')
      && SONIC_3_LANGUAGES.has(String(v.language).toLowerCase()))
    .map((v) => {
      const label = String(v.name || v.id).replace(/\s+/g, ' ').trim();
      const about = String(v.description || '').replace(/\s+/g, ' ').trim();
      const gender = GENDERS[String(v.gender || '').toLowerCase()];
      return {
        name: v.id,
        description: about ? `${label}: ${about}` : label,
        ...(gender ? { gender } : {}),
        language: voiceLocale(v),
      };
    });
}

let cache = { at: 0, promise: null };

/** Forget the cached catalogue (tests). */
export function resetCartesiaVoicesCache() {
  cache = { at: 0, promise: null };
}

async function fetchPage({ fetchImpl, key, cursor }) {
  const url = `${CARTESIA_VOICES_URL}?limit=${PAGE_SIZE}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': CARTESIA_VERSION },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The mapped catalogue, every page fetched with the platform key and cached for ten minutes. A failed
 * fetch is not cached, so the next request retries.
 */
export async function fetchCartesiaVoices({ fetchImpl = fetch, key = process.env.CARTESIA_API_KEY, logger = defaultLogger, now = Date.now } = {}) {
  if (!key) return [];
  if (cache.promise && now() - cache.at < CACHE_TTL_MS) return cache.promise;
  const promise = (async () => {
    const rows = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await fetchPage({ fetchImpl, key, cursor });
      const data = Array.isArray(body?.data) ? body.data : [];
      rows.push(...data);
      cursor = body?.has_more ? (body.next_page || data.at(-1)?.id) : undefined;
      if (!cursor) break;
    }
    return mapCartesiaVoices(rows);
  })();
  cache = { at: now(), promise };
  try {
    return await promise;
  } catch (err) {
    if (cache.promise === promise) resetCartesiaVoicesCache();
    logger.error({ error: err?.message }, 'Cartesia voice catalogue fetch failed');
    throw err;
  }
}

class Cartesia {
  static name = 'cartesia';
  static description = 'Cartesia TTS';

  constructor(logger) {
    this.logger = logger.child({ cartesiaHelper: true });
  }

  get useSsml() {
    return false;
  }

  get speak() {
    return speak.text;
  }

  /**
   * Cartesia voices as locale → voices.
   *
   * @param {string} [languageCode] keep only locales starting with this
   * @returns {Promise<Record<string, object[]>>}
   */
  async listVoices(languageCode) {
    try {
      const list = await fetchCartesiaVoices({ logger: this.logger });
      return list
        .filter((voice) => !languageCode || voice.language.startsWith(languageCode))
        .reduce((o, { language, ...voice }) => ({ ...o, [language]: [...(o[language] || []), voice] }), {});
    } catch {
      return {};
    }
  }
}

export default Cartesia;
