// Planning for scripts/add-typesafe-rate-lines.mjs, no database (docs/typesafe-jev.md).
import {
  typesafeAdditions,
  typesafeLines,
  inputPriceFor,
  pricesTextModels,
  DEFAULT_INPUT_PRICE_MICROS,
} from '../scripts/add-typesafe-rate-lines.mjs';

const line = (provider, detail, unit, priceMicros) => ({
  dim: 'model', match: { technology: 'llm', provider, detail, unit }, unit: 'token', priceMicros,
});

describe('add-typesafe-rate-lines planning', () => {
  test('the lines match the detail form the driver records: provider typesafe, the stripped id', () => {
    expect(typesafeLines()).toEqual([
      line('typesafe', 'jev-1.13.0', 'input_tokens', 3.5),
      line('typesafe', 'jev-1.13.0', 'output_tokens', 0),
    ]);
    // USD 0.042 per million at 1.20 USD per GBP is 3.5 micro-pence per token.
    expect(DEFAULT_INPUT_PRICE_MICROS).toBe(3.5);
  });

  test('a card that prices text models gains both lines once; a rerun adds nothing', () => {
    const card = [line('anthropic', 'claude-sonnet-5', 'input_tokens', 2.2), line('xai', 'grok-4.3', 'output_tokens', 1.8)];
    expect(pricesTextModels(card)).toBe(true);
    expect(pricesTextModels([{ dim: 'tts', match: { technology: 'tts', provider: 'cartesia', unit: 'characters' }, unit: 'character', priceMicros: 55 }])).toBe(false);
    const additions = typesafeAdditions(card, 3.5);
    expect(additions).toEqual(typesafeLines(3.5));
    expect(typesafeAdditions([...card, ...additions], 3.5)).toEqual([]);
  });

  test('an existing line keeps its price and only the missing unit is added', () => {
    const card = [line('typesafe', 'jev-1.13.0', 'input_tokens', 4)];
    expect(typesafeAdditions(card, 3.5)).toEqual([line('typesafe', 'jev-1.13.0', 'output_tokens', 0)]);
    // The catalogue's own detail form (vendor/model) is a different tuple and does not satisfy the check.
    expect(typesafeAdditions([line('typesafe', 'typesafe/jev-1.13.0', 'input_tokens', 4)], 3.5)).toHaveLength(2);
  });

  test('TYPESAFE_INPUT_PRICE_MICROS overrides the vendor list price', () => {
    expect(inputPriceFor({})).toBe(3.5);
    expect(inputPriceFor({ TYPESAFE_INPUT_PRICE_MICROS: '2.9' })).toBe(2.9);
    expect(typesafeAdditions([], inputPriceFor({ TYPESAFE_INPUT_PRICE_MICROS: '2.9' }))[0].priceMicros).toBe(2.9);
  });
});
