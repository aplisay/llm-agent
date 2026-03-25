import { createSqlAgentConcurrencyLimits, AgentConcurrencyLimitExceededError } from './agent-concurrency-limits-sql.js';
import { createRedisAgentConcurrencyLimits } from './agent-concurrency-limits-redis.js';

export { AgentConcurrencyLimitExceededError };

/**
 * @param {Parameters<typeof createSqlAgentConcurrencyLimits>[0]} deps
 */
export function createAgentConcurrencyLimits(deps) {
  const backend = (process.env.AGENT_CONCURRENCY_STORE || 'sql').toLowerCase();
  if (backend === 'redis') {
    return createRedisAgentConcurrencyLimits(deps);
  }
  return createSqlAgentConcurrencyLimits(deps);
}
