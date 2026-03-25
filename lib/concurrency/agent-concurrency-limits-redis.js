import { AgentConcurrencyLimitExceededError } from './agent-concurrency-limits-sql.js';

export { AgentConcurrencyLimitExceededError };

/**
 * Placeholder Redis-backed store. Wire REDIS_URL + ioredis when ready.
 * @param {object} _deps unused for now
 */
export function createRedisAgentConcurrencyLimits(_deps) {
  const notReady = async () => {
    throw new Error(
      'Redis agent concurrency store is not implemented yet; set AGENT_CONCURRENCY_STORE=sql (default)',
    );
  };
  return {
    reserveForCall: notReady,
    releaseCall: async () => {},
    getCounts: notReady,
  };
}
