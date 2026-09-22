import Neuphonic, {
  NEUPHONIC_VOICES_URL,
  fetchNeuphonicVoices,
  mapNeuphonicVoices,
  resetNeuphonicVoicesCache,
} from '../lib/voices/neuphonic.js';
import { getTtsVendorsForAgentValidation, getVoiceNamesForAgentValidation } from '../lib/model-voices.js';
import { buildRateComponents, TTS_ENGINES } from '../lib/rate-components.js';
import { characterPriceFor, neuphonicAdditions, neuphonicLines, pricesTts } from '../scripts/add-neuphonic-rate-lines.mjs';
import { NEUPHONIC_FIXTURE } from './fixtures/neuphonic-voices.mjs';

/**
 * Neuphonic as a platform TTS vendor (docs/neuphonic.md): the voice catalogue, the vendor
 * allow-lists that decide where it may be chosen, and the rate lines that price it. Pure:
 * the catalogue fetch is injected. Save-time validation is tests/agent-neuphonic-options.test.mjs.
 */

const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));

describe('Neuphonic voice catalogue', () => {
  test('maps voices to locales, genders and descriptions, stock voices only', () => {
    const rows = byName(mapNeuphonicVoices(NEUPHONIC_FIXTURE));
    expect(rows['v-emily']).toEqual({ name: 'v-emily', description: 'Emily - American, Conversational', gender: 'female', language: 'en-US' });
    expect(rows['v-liz'].language).toBe('en-GB');
    expect(rows['v-callum'].language).toBe('en-GB');
    expect(rows['v-liam'].language).toBe('en-IE');
    expect(rows['v-jack'].language).toBe('en-AU');
    expect(rows['v-ishita'].language).toBe('en-IN');
    // No accent tag: the language's most likely region.
    expect(rows['v-rebecca'].language).toBe('en-US');
    expect(rows['v-alejandra'].language).toBe('es-VE');
    expect(rows['v-mateo']).toEqual({ name: 'v-mateo', description: 'Mateo', language: 'es-ES' });
    expect(rows['v-cadu'].language).toBe('pt-BR');
    expect(rows['v-manoel'].language).toBe('pt-PT');
    expect(rows['v-emilia'].language).toBe('de-DE');
    expect(rows['v-ruoxi']).toMatchObject({ gender: 'female', language: 'zh-CN' });
    expect(rows['v-seojun'].description).toBe('Seo-jun (서준)');
    // A cloned voice belongs to whoever cloned it; a row with no language is unusable.
    expect(rows['v-clone']).toBeUndefined();
    expect(rows['v-nolang']).toBeUndefined();
  });

  test('tolerates an empty or malformed body', () => {
    expect(mapNeuphonicVoices(undefined)).toEqual([]);
    expect(mapNeuphonicVoices({ data: {} })).toEqual([]);
  });

  describe('fetch', () => {
    const quiet = { error: () => { }, child: () => quiet };
    const ok = () => ({ ok: true, status: 200, json: async () => NEUPHONIC_FIXTURE });
    beforeEach(() => resetNeuphonicVoicesCache());

    test('no key, no request', async () => {
      const calls = [];
      const rows = await fetchNeuphonicVoices({ key: '', fetchImpl: async (...a) => { calls.push(a); return ok(); }, logger: quiet });
      expect(rows).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    test('sends the key and caches the catalogue for ten minutes', async () => {
      const calls = [];
      const fetchImpl = async (url, init) => { calls.push({ url, key: init.headers['X-API-KEY'] }); return ok(); };
      let t = 1_000_000;
      const now = () => t;
      const first = await fetchNeuphonicVoices({ key: 'k', fetchImpl, now, logger: quiet });
      await fetchNeuphonicVoices({ key: 'k', fetchImpl, now, logger: quiet });
      expect(calls).toEqual([{ url: NEUPHONIC_VOICES_URL, key: 'k' }]);
      expect(first.length).toBeGreaterThan(10);
      t += 10 * 60 * 1000 + 1;
      await fetchNeuphonicVoices({ key: 'k', fetchImpl, now, logger: quiet });
      expect(calls).toHaveLength(2);
    });

    test('a failed fetch is not cached', async () => {
      let fail = true;
      const fetchImpl = async () => (fail ? { ok: false, status: 503, json: async () => ({}) } : ok());
      await expect(fetchNeuphonicVoices({ key: 'k', fetchImpl, logger: quiet })).rejects.toThrow('HTTP 503');
      fail = false;
      await expect(fetchNeuphonicVoices({ key: 'k', fetchImpl, logger: quiet })).resolves.toHaveLength(14);
    });

    test('the service lists voices by locale, filtered by language, and {} on failure', async () => {
      const saved = { key: process.env.NEUPHONIC_API_KEY, fetch: globalThis.fetch };
      process.env.NEUPHONIC_API_KEY = 'k';
      try {
        globalThis.fetch = async () => ok();
        const service = new Neuphonic(quiet);
        const tree = await service.listVoices();
        expect(Object.keys(tree)).toEqual(expect.arrayContaining(['en-US', 'en-GB', 'es-VE', 'pt-PT', 'de-DE']));
        expect(tree['en-GB'].map((v) => v.name).sort()).toEqual(['v-callum', 'v-liz']);
        expect(tree['en-GB'][0]).not.toHaveProperty('language');
        expect(Object.keys(await service.listVoices('pt'))).toEqual(expect.arrayContaining(['pt-BR', 'pt-PT']));
        expect(Object.keys(await service.listVoices('pt'))).toHaveLength(2);

        resetNeuphonicVoicesCache();
        globalThis.fetch = async () => { throw new Error('offline'); };
        expect(await service.listVoices()).toEqual({});
      } finally {
        globalThis.fetch = saved.fetch;
        if (saved.key === undefined) delete process.env.NEUPHONIC_API_KEY; else process.env.NEUPHONIC_API_KEY = saved.key;
        resetNeuphonicVoicesCache();
      }
    });
  });
});

describe('where Neuphonic may be chosen', () => {
  const tree = {
    neuphonic: { 'en-GB': [{ name: 'v-liz', description: 'Liz - British', gender: 'female' }] },
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
    expect(vendors.has('neuphonic')).toBe(true);
    expect(names.has('v-liz')).toBe(true);
  });

  test.each([
    ['pipecat:openai/gpt-4o-mini', false],
    ['livekit:openai/gpt-4o-mini', false],
    ['pipecat:ultravox/ultravox-v0.7', true],
  ])('%s still accepts the vendor while the catalogue cannot be fetched', async (modelName, discreteTts) => {
    const vendors = await getTtsVendorsForAgentValidation({ modelName, Handler, voicesInstance: catalogueDown, discreteTts });
    expect(vendors.has('neuphonic')).toBe(true);
  });

  test('a realtime row keeps its own voices when the vendor is native', async () => {
    const modelName = 'pipecat:ultravox/ultravox-v0.7';
    const names = await getVoiceNamesForAgentValidation({ modelName, Handler, voicesInstance: withCatalogue });
    expect(names.has('v-liz')).toBe(false);
  });
});

describe('Neuphonic billing', () => {
  test('the rate-card roster offers tts:neuphonic per character or minute', () => {
    expect(TTS_ENGINES).toContain('neuphonic');
    const component = buildRateComponents({ implementations: [], models: [] }).find((c) => c.key === 'tts:neuphonic');
    expect(component).toMatchObject({ dim: 'tts', match: { technology: 'tts', provider: 'neuphonic' }, units: ['character', 'minute'] });
  });

  const cartesia = [
    { dim: 'tts', match: { technology: 'tts', provider: 'cartesia', unit: 'characters' }, unit: 'character', priceMicros: 55 },
    { dim: 'tts', match: { technology: 'tts', provider: 'cartesia', unit: 'milliseconds' }, unit: 'minute', priceMicros: 0 },
  ];

  test('the rate script copies each card\'s Cartesia character price, or the override', () => {
    expect(characterPriceFor(cartesia, {})).toBe(55);
    expect(characterPriceFor(cartesia, { NEUPHONIC_CHARACTER_PRICE_MICROS: '70' })).toBe(70);
    expect(characterPriceFor([], {})).toBeUndefined();
  });

  test('it adds a character line and a zero minute line, once', () => {
    const additions = neuphonicAdditions(cartesia, 55);
    expect(additions).toEqual([
      { dim: 'tts', match: { technology: 'tts', provider: 'neuphonic', unit: 'characters' }, unit: 'character', priceMicros: 55 },
      { dim: 'tts', match: { technology: 'tts', provider: 'neuphonic', unit: 'milliseconds' }, unit: 'minute', priceMicros: 0 },
    ]);
    expect(neuphonicAdditions([...cartesia, ...additions], 55)).toEqual([]);
    expect(neuphonicAdditions([...cartesia, neuphonicLines(40)[0]], 55)).toEqual([neuphonicLines(55)[1]]);
  });

  test('only cards that price a TTS engine are targets, besides the default card', () => {
    expect(pricesTts(cartesia)).toBe(true);
    expect(pricesTts([{ dim: 'tts', match: { technology: 'tts', provider: 'ultravox', unit: 'milliseconds' }, unit: 'minute', priceMicros: 0 }])).toBe(false);
    expect(pricesTts([])).toBe(false);
  });
});
