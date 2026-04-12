import { createRedisAgentConcurrencyLimits } from '../lib/concurrency/agent-concurrency-limits-redis.js';

describe('Redis agent concurrency skeleton', () => {
  test('reserveForCall is not implemented', async () => {
    const store = createRedisAgentConcurrencyLimits({});
    await expect(store.reserveForCall({ id: 'x' })).rejects.toThrow(
      /not implemented/i,
    );
  });
});
