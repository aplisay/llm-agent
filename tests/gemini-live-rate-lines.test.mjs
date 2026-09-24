// Planning for scripts/add-gemini-live-rate-lines.mjs, no database.
import {
  DETAIL,
  factorFor,
  geminiLiveAdditions,
  pricesFor,
  pricesModels,
} from '../scripts/add-gemini-live-rate-lines.mjs';

const line = (provider, detail, unit, priceMicros) => ({
  dim: 'model', match: { technology: 'llm', provider, detail, unit }, unit: 'token', priceMicros,
});

describe('add-gemini-live-rate-lines planning', () => {
  // Shaped like the staging cards: models at 0.7333 of the list digits (Sonnet 5 input 3 -> 2.2).
  const card = [
    line('anthropic', 'claude-sonnet-5', 'input_tokens', 2.2),
    line('google', 'google/gemini-2.0-flash-exp', 'input_tokens', 0.1),
    line('google', 'google/gemini-2.0-flash-exp', 'output_tokens', 0.4),
    line('google', 'google/gemini-2.5-flash', 'input_tokens', 0.22),
  ];

  test('the three token lines for the new detail, at the card factor of the audio list prices', () => {
    expect(factorFor(card, {})).toBe(0.7333);
    expect(geminiLiveAdditions(card, { env: {}, factor: factorFor(card, {}) })).toEqual([
      line('google', DETAIL, 'input_tokens', 2.2),
      line('google', DETAIL, 'output_tokens', 8.8),
      line('google', DETAIL, 'cache_read_tokens', 0.22),
    ]);
  });

  test('a card with no Sonnet 5 line takes the raw list digits', () => {
    const bare = [line('google', 'google/gemini-2.5-flash', 'input_tokens', 0.3)];
    expect(factorFor(bare, {})).toBe(1);
    expect(geminiLiveAdditions(bare, { env: {} }).map((l) => l.priceMicros)).toEqual([3, 12, 0.3]);
  });

  test('env overrides win, and the xAI factor variable is ignored', () => {
    const env = {
      GEMINI_LIVE_PRICE_FACTOR: '0.5',
      GEMINI_LIVE_OUTPUT_PRICE_MICROS: '9',
      XAI_PRICE_FACTOR: '2',
    };
    expect(factorFor(card, env)).toBe(0.5);
    expect(pricesFor(env, factorFor(card, env))).toEqual({ input: 1.5, output: 9, cacheRead: 0.15 });
    expect(factorFor(card, { XAI_PRICE_FACTOR: '2' })).toBe(0.7333);
  });

  test('a rerun adds nothing, an existing line keeps its price, and the old lines stay', () => {
    const once = [...card, ...geminiLiveAdditions(card, { env: {}, factor: 0.7333 })];
    expect(geminiLiveAdditions(once, { env: {}, factor: 0.7333 })).toEqual([]);
    const repriced = once.map((l) => (l.match.detail === DETAIL && l.match.unit === 'input_tokens' ? { ...l, priceMicros: 1 } : l));
    expect(geminiLiveAdditions(repriced, { env: {}, factor: 0.7333 })).toEqual([]);
    expect(once.filter((l) => l.match.detail === 'google/gemini-2.0-flash-exp')).toHaveLength(2);
  });

  test('only cards that price models are targets', () => {
    expect(pricesModels(card)).toBe(true);
    expect(pricesModels([{ dim: 'tts', match: { technology: 'tts', provider: 'cartesia' }, unit: 'character', priceMicros: 55 }])).toBe(false);
    expect(pricesModels([])).toBe(false);
  });
});
