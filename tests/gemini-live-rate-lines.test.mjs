// Planning for scripts/add-gemini-live-rate-lines.mjs, no database.
import {
  DETAIL,
  cardPricesFor,
  factorFor,
  geminiLiveAdditions,
  oldIdPrice,
  pricesFor,
  pricesModels,
} from '../scripts/add-gemini-live-rate-lines.mjs';

const line = (provider, detail, unit, priceMicros) => ({
  dim: 'model', match: { technology: 'llm', provider, detail, unit }, unit: 'token', priceMicros,
});

const oldIdLines = (provider, detail, [input, output, cacheRead]) => [
  line(provider, detail, 'input_tokens', input),
  line(provider, detail, 'output_tokens', output),
  line(provider, detail, 'cache_read_tokens', cacheRead),
];

describe('add-gemini-live-rate-lines planning', () => {
  // Shaped like the plan cards: models at 0.7333 of the list digits by the
  // Sonnet 5 reference, and the retired id already priced as a native-audio
  // model under all three detail forms.
  const card = [
    line('anthropic', 'claude-sonnet-5', 'input_tokens', 2.2),
    ...oldIdLines('google', 'gemini-2.0-flash-exp', [3.3, 14, 0.33]),
    ...oldIdLines('google', 'google/gemini-2.0-flash-exp', [3.3, 14, 0.33]),
    ...oldIdLines('gemini', 'gemini/gemini-2.0-flash-exp', [3.3, 14, 0.33]),
    line('google', 'google/gemini-2.5-flash', 'input_tokens', 0.33),
  ];

  test('the new lines copy the prices the card already charges for the retired id', () => {
    const factor = factorFor(card, {});
    expect(factor).toBe(0.7333);
    expect(geminiLiveAdditions(card, { env: {}, factor })).toEqual([
      line('google', DETAIL, 'input_tokens', 3.3),
      line('google', DETAIL, 'output_tokens', 14),
      line('google', DETAIL, 'cache_read_tokens', 0.33),
    ]);
  });

  test('the google/ detail form is copied first, then the bare id', () => {
    const both = [
      ...oldIdLines('google', 'gemini-2.0-flash-exp', [1, 2, 0.1]),
      ...oldIdLines('google', 'google/gemini-2.0-flash-exp', [3.3, 14, 0.33]),
    ];
    expect(cardPricesFor(both, { env: {} })).toEqual({ input: 3.3, output: 14, cacheRead: 0.33 });
    const bare = oldIdLines('google', 'gemini-2.0-flash-exp', [1, 2, 0.1]);
    expect(cardPricesFor(bare, { env: {} })).toEqual({ input: 1, output: 2, cacheRead: 0.1 });
    // another provider's line for the same model is not the retired id's price
    expect(oldIdPrice(oldIdLines('gemini', 'gemini/gemini-2.0-flash-exp', [3.3, 14, 0.33]), 'input_tokens')).toBeUndefined();
  });

  test('a card with no retired-id line takes the list prices at its factor', () => {
    const noOld = [line('anthropic', 'claude-sonnet-5', 'input_tokens', 2.2), line('google', 'google/gemini-2.5-flash', 'input_tokens', 0.22)];
    expect(geminiLiveAdditions(noOld, { env: {}, factor: factorFor(noOld, {}) }).map((l) => l.priceMicros)).toEqual([2.2, 8.8, 0.22]);
    const bare = [line('google', 'google/gemini-2.5-flash', 'input_tokens', 0.3)];
    expect(factorFor(bare, {})).toBe(1);
    expect(geminiLiveAdditions(bare, { env: {} }).map((l) => l.priceMicros)).toEqual([3, 12, 0.3]);
  });

  test('a unit the card has no retired-id line for falls back on its own', () => {
    const partial = [
      line('anthropic', 'claude-sonnet-5', 'input_tokens', 2.2),
      line('google', 'google/gemini-2.0-flash-exp', 'input_tokens', 3.3),
      line('google', 'google/gemini-2.0-flash-exp', 'output_tokens', 14),
    ];
    expect(cardPricesFor(partial, { env: {}, factor: factorFor(partial, {}) })).toEqual({ input: 3.3, output: 14, cacheRead: 0.22 });
  });

  test('env overrides win over the copy, and the xAI factor variable is ignored', () => {
    const env = {
      GEMINI_LIVE_PRICE_FACTOR: '0.5',
      GEMINI_LIVE_OUTPUT_PRICE_MICROS: '9',
      XAI_PRICE_FACTOR: '2',
    };
    expect(factorFor(card, env)).toBe(0.5);
    expect(pricesFor(env, factorFor(card, env))).toEqual({ input: 1.5, output: 9, cacheRead: 0.15 });
    // the factor only prices a unit with nothing to copy
    expect(cardPricesFor(card, { env, factor: factorFor(card, env) })).toEqual({ input: 3.3, output: 9, cacheRead: 0.33 });
    expect(factorFor(card, { XAI_PRICE_FACTOR: '2' })).toBe(0.7333);
  });

  test('a rerun adds nothing, an existing line keeps its price, and the old lines stay', () => {
    const once = [...card, ...geminiLiveAdditions(card, { env: {}, factor: 0.7333 })];
    expect(geminiLiveAdditions(once, { env: {}, factor: 0.7333 })).toEqual([]);
    const repriced = once.map((l) => (l.match.detail === DETAIL && l.match.unit === 'input_tokens' ? { ...l, priceMicros: 1 } : l));
    expect(geminiLiveAdditions(repriced, { env: {}, factor: 0.7333 })).toEqual([]);
    expect(once.filter((l) => l.match.detail === 'google/gemini-2.0-flash-exp')).toHaveLength(3);
  });

  test('only cards that price models are targets', () => {
    expect(pricesModels(card)).toBe(true);
    expect(pricesModels([{ dim: 'tts', match: { technology: 'tts', provider: 'cartesia' }, unit: 'character', priceMicros: 55 }])).toBe(false);
    expect(pricesModels([])).toBe(false);
  });
});
