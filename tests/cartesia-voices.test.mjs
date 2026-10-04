import Cartesia, {
  CARTESIA_VERSION,
  CARTESIA_VOICES_URL,
  loadCartesiaVoices,
  mapCartesiaVoices,
  resetCartesiaVoicesCache,
} from '../lib/voices/cartesia.js';
import { getTtsVendorsForAgentValidation, getVoiceNamesForAgentValidation } from '../lib/model-voices.js';
import { CARTESIA_PAGES } from './fixtures/cartesia-voices.mjs';

/**
 * The Cartesia voice catalogue and the vendor allow-lists that decide where its voices may be
 * chosen. Pure: the catalogue fetch is injected.
 */

const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));
const allVoices = CARTESIA_PAGES.flatMap((p) => p.data);

describe('Cartesia voice catalogue', () => {
  test('maps voices to locales, genders and descriptions, stock sonic-3 voices only', () => {
    const rows = byName(mapCartesiaVoices(allVoices));
    expect(rows['c-skylar']).toEqual({
      name: 'c-skylar', description: 'Skylar - Friendly Guide: Approachable American female.', gender: 'female', language: 'en-US',
    });
    expect(rows['c-george']).toMatchObject({ gender: 'male', language: 'en-GB' });
    expect(rows['c-katie']).toEqual({ name: 'c-katie', description: 'Katie', gender: 'female', language: 'en-AU' });
    expect(rows['c-luc']).toMatchObject({ description: 'Luc: Warm Quebec voice.', language: 'fr-CA' });
    expect(rows['c-varun'].language).toBe('hi-IN');
    expect(rows['c-gerard'].language).toBe('es-MX');
    expect(rows['c-sam']).toEqual({ name: 'c-sam', description: 'Sam', language: 'de-DE' });
    expect(rows['c-zara']).toBeUndefined();
    expect(rows['c-clone']).toBeUndefined();
    expect(rows['c-gone']).toBeUndefined();
    expect(rows['c-nolang']).toBeUndefined();
  });

  test('tolerates an empty or malformed body', () => {
    expect(mapCartesiaVoices(undefined)).toEqual([]);
    expect(mapCartesiaVoices([null, {}])).toEqual([]);
  });

  describe('fetch', () => {
    const quiet = { error: () => { }, child: () => quiet };
    const paged = (calls) => async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization, version: init.headers['Cartesia-Version'] });
      const page = new URL(url).searchParams.get('starting_after') ? CARTESIA_PAGES[1] : CARTESIA_PAGES[0];
      return { ok: true, status: 200, json: async () => page };
    };
    beforeEach(() => resetCartesiaVoicesCache());

    test('no key, no request', async () => {
      const calls = [];
      expect(await loadCartesiaVoices({ key: '', fetchImpl: paged(calls) })).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    test('follows the page cursor and sends the key', async () => {
      const calls = [];
      const rows = await loadCartesiaVoices({ key: 'k', fetchImpl: paged(calls) });
      expect(calls).toEqual([
        { url: `${CARTESIA_VOICES_URL}?limit=100`, auth: 'Bearer k', version: CARTESIA_VERSION },
        { url: `${CARTESIA_VOICES_URL}?limit=100&starting_after=c-katie`, auth: 'Bearer k', version: CARTESIA_VERSION },
      ]);
      expect(rows.map((v) => v.name).sort()).toEqual(['c-george', 'c-gerard', 'c-katie', 'c-luc', 'c-sam', 'c-skylar', 'c-varun']);
    });

    test('a failed page fails the load', async () => {
      const calls = [];
      const ok = paged(calls);
      const fetchImpl = async (url, init) => (url.includes('starting_after')
        ? { ok: false, status: 503, json: async () => ({}) }
        : ok(url, init));
      await expect(loadCartesiaVoices({ key: 'k', fetchImpl })).rejects.toThrow('HTTP 503');
    });

    test('the service lists voices by locale, filtered by language, and {} on failure', async () => {
      const saved = { key: process.env.CARTESIA_API_KEY, fetch: globalThis.fetch };
      process.env.CARTESIA_API_KEY = 'k';
      try {
        globalThis.fetch = paged([]);
        const service = new Cartesia(quiet);
        const tree = await service.listVoices();
        expect(Object.keys(tree).sort()).toEqual(['de-DE', 'en-AU', 'en-GB', 'en-US', 'es-MX', 'fr-CA', 'hi-IN']);
        expect(tree['en-GB']).toEqual([{ name: 'c-george', description: 'George: Calm British man.', gender: 'male' }]);
        expect(Object.keys(await service.listVoices('en')).sort()).toEqual(['en-AU', 'en-GB', 'en-US']);

        resetCartesiaVoicesCache();
        globalThis.fetch = async () => { throw new Error('offline'); };
        expect(await service.listVoices()).toEqual({});
      } finally {
        globalThis.fetch = saved.fetch;
        if (saved.key === undefined) delete process.env.CARTESIA_API_KEY; else process.env.CARTESIA_API_KEY = saved.key;
        resetCartesiaVoicesCache();
      }
    });
  });
});

describe('where Cartesia voices may be chosen', () => {
  const tree = {
    cartesia: { 'en-GB': [{ name: 'c-george', description: 'George', gender: 'male' }] },
    elevenlabs: { 'en-GB': [{ name: 'Rachel' }] },
  };
  const withCatalogue = { listVoices: async () => tree };
  const catalogueDown = { listVoices: async () => ({ elevenlabs: tree.elevenlabs }) };
  const Handler = { voices: Promise.resolve({ ultravox: { any: [{ name: 'Mark' }] } }) };

  test.each([
    ['pipecat:openai/gpt-4o-mini', false],
    ['livekit:openai/gpt-4o-mini', false],
    ['pipecat:ultravox/ultravox-v0.7', true],
    ['livekit:ultravox/ultravox-v0.7', true],
    ['livekit:openai/gpt-realtime', true],
  ])('%s accepts the vendor and its voices (external TTS: %s)', async (modelName, discreteTts) => {
    const vendors = await getTtsVendorsForAgentValidation({ modelName, Handler, voicesInstance: withCatalogue, discreteTts });
    const names = await getVoiceNamesForAgentValidation({ modelName, Handler, voicesInstance: withCatalogue, discreteTts });
    expect(vendors.has('cartesia')).toBe(true);
    expect(names.has('c-george')).toBe(true);
  });

  test.each([
    ['pipecat:openai/gpt-4o-mini', false],
    ['livekit:openai/gpt-4o-mini', false],
    ['pipecat:ultravox/ultravox-v0.7', true],
  ])('%s still accepts the vendor while the catalogue cannot be fetched', async (modelName, discreteTts) => {
    const vendors = await getTtsVendorsForAgentValidation({ modelName, Handler, voicesInstance: catalogueDown, discreteTts });
    expect(vendors.has('cartesia')).toBe(true);
  });

  test('a realtime row keeps its own voices when the vendor is native', async () => {
    const names = await getVoiceNamesForAgentValidation({
      modelName: 'pipecat:ultravox/ultravox-v0.7', Handler, voicesInstance: withCatalogue,
    });
    expect(names.has('c-george')).toBe(false);
  });
});
