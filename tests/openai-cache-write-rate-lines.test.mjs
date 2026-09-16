// Planning for scripts/add-openai-cache-write-rate-lines.mjs, no database. See #309.
import {
  cacheWriteAdditions,
  cacheWritePrice,
  modelForDetail,
} from '../scripts/add-openai-cache-write-rate-lines.mjs';

const line = (provider, detail, unit, priceMicros) => ({
  dim: 'model', match: { technology: 'llm', provider, detail, unit }, unit: 'token', priceMicros,
});

describe('add-openai-cache-write-rate-lines planning', () => {
  // Shaped like the staging cards: each model priced under several detail forms.
  const card = [
    line('openai', 'gpt-5.6-terra', 'input_tokens', 2.2),
    line('openai', 'gpt-5.6-terra', 'output_tokens', 14),
    line('openai', 'gpt-5.6-terra', 'cache_read_tokens', 0.22),
    line('openai', 'openai/gpt-5.6-terra', 'input_tokens', 2.2),
    line('openai', 'gpt-5.6-luna', 'input_tokens', 0.22),
    line('openai', 'gpt-5.6-sol', 'input_tokens', 5.5),
    line('openai', 'gpt-5.6-sol', 'cache_write_tokens', 7),
    line('openai', 'gpt-5.5', 'input_tokens', 5.5),
    line('openrouter', 'openai/gpt-5.6-terra', 'input_tokens', 2.6),
    line('openrouter', 'openrouter/gpt-5.6-terra', 'input_tokens', 2.6),
    line('openrouter', 'anthropic/claude-sonnet-5', 'input_tokens', 2.6),
    line('anthropic', 'claude-sonnet-5', 'input_tokens', 2.2),
    line('xai', 'gpt-5.6-terra', 'input_tokens', 1),
    { dim: 'model', match: { technology: 'voice', detail: 'pipecat:openai/gpt-live-1' }, unit: 'minute', priceMicros: 90000 },
  ];

  test('a cache_write_tokens line beside each GPT-5.6 input line, at 1.25x the input price', () => {
    expect(cacheWriteAdditions(card)).toEqual([
      line('openai', 'gpt-5.6-terra', 'cache_write_tokens', 2.8),
      line('openai', 'openai/gpt-5.6-terra', 'cache_write_tokens', 2.8),
      line('openai', 'gpt-5.6-luna', 'cache_write_tokens', 0.28),
      line('openrouter', 'openai/gpt-5.6-terra', 'cache_write_tokens', 3.3),
      line('openrouter', 'openrouter/gpt-5.6-terra', 'cache_write_tokens', 3.3),
    ]);
  });

  test('a rerun adds nothing, and an existing line keeps its price', () => {
    const once = [...card, ...cacheWriteAdditions(card)];
    expect(cacheWriteAdditions(once)).toEqual([]);
    expect(once.filter((l) => l.match.detail === 'gpt-5.6-sol' && l.match.unit === 'cache_write_tokens'))
      .toEqual([line('openai', 'gpt-5.6-sol', 'cache_write_tokens', 7)]);
  });

  test('a duplicate input line yields one addition', () => {
    const dup = [line('openai', 'gpt-5.6-luna', 'input_tokens', 0.22), line('openai', 'gpt-5.6-luna', 'input_tokens', 0.22)];
    expect(cacheWriteAdditions(dup)).toHaveLength(1);
  });

  test('prices round to two significant figures after the float noise is removed', () => {
    expect(cacheWritePrice(5.5)).toBe(6.9);
    expect(cacheWritePrice(2.2)).toBe(2.8);
    expect(cacheWritePrice(0.22)).toBe(0.28);
    expect(cacheWritePrice(0.022)).toBe(0.028);
    expect(cacheWritePrice(2.6)).toBe(3.3);
    expect(cacheWritePrice(2.2, 2)).toBe(4.4);
  });

  test('the model match takes a bare id or one behind vendor segments, never a longer id', () => {
    expect(modelForDetail('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(modelForDetail('openrouter/openai/gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(modelForDetail('gpt-5.6-terra-mini')).toBeUndefined();
    expect(modelForDetail('openai/gpt-5.5')).toBeUndefined();
    expect(modelForDetail(undefined)).toBeUndefined();
    expect(cacheWriteAdditions([line('openai', 'gpt-5.5', 'input_tokens', 5.5)], { models: ['gpt-5.5'] }))
      .toEqual([line('openai', 'gpt-5.5', 'cache_write_tokens', 6.9)]);
  });
});
