/** Thrown when a new call would exceed instance/user/org agentLimit. */
export class AgentConcurrencyLimitExceededError extends Error {
  /**
   * @param {'instance'|'user'|'organisation'} scope
   * @param {string} message
   * @param {{ limit?: number | null, current?: number, callId?: string }} [details]
   */
  constructor(scope, message, details = {}) {
    super(message);
    this.name = 'AgentConcurrencyLimitExceededError';
    this.scope = scope;
    this.details = details;
    this.code = 'AGENT_CONCURRENCY_LIMIT_EXCEEDED';
  }
}

const PG_SERIALIZATION_FAILURE = '40001';

/**
 * @param {object} deps
 * @param {import('sequelize').Sequelize} deps.sequelize
 * @param {typeof import('sequelize').Transaction} deps.Transaction
 * @param {import('sequelize').ModelStatic<any>} deps.Instance
 * @param {import('sequelize').ModelStatic<any>} deps.User
 * @param {import('sequelize').ModelStatic<any>} deps.Organisation
 * @param {import('sequelize').ModelStatic<any>} deps.CallConcurrency
 * @param {{ warn: Function, error: Function }} deps.logger
 */
export function createSqlAgentConcurrencyLimits(deps) {
  const {
    sequelize,
    Transaction,
    Instance,
    User,
    Organisation,
    CallConcurrency,
    logger,
  } = deps;

  /**
   * @param {number | null | undefined} limit
   * @param {number} currentCount
   * @param {'instance'|'user'|'organisation'} scope
   * @param {string} callId
   */
  function enforceLimit(limit, currentCount, scope, callId) {
    if (limit == null) {
      return;
    }
    if (limit === 0) {
      throw new AgentConcurrencyLimitExceededError(
        scope,
        `agentLimit is 0 for ${scope}: no concurrent agents allowed`,
        { limit: 0, current: currentCount, callId },
      );
      return;
    }
    if (limit > 0 && currentCount >= limit) {
      throw new AgentConcurrencyLimitExceededError(
        scope,
        `agent concurrency limit exceeded for ${scope} (${currentCount} >= ${limit})`,
        { limit, current: currentCount, callId },
      );
    }
  }

  /**
   * @param {import('sequelize').Model} call Sequelize Call instance
   */
  async function reserveForCall(call, context = {}) {
    const callId = call.id;
    const instanceId = call.instanceId;
    const userId = call.userId;
    const organisationId = call.organisationId;

    if (!callId || !instanceId) {
      throw new Error('Call.reserveForCall: call must have id and instanceId');
    }

    const maxAttempts = 5;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await sequelize.transaction(
          {
            isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
          },
          async (transaction) => {
            const alreadyReserved = await CallConcurrency.findByPk(callId, { transaction });
            if (alreadyReserved) {
              return;
            }

            const instanceRow =
              context.instance && typeof context.instance.agentLimit !== 'undefined'
                ? context.instance
                : await Instance.findByPk(instanceId, { transaction });
            if (!instanceRow) {
              throw new Error(`Instance not found: ${instanceId}`);
            }

            const userRow =
              context.user && typeof context.user.agentLimit !== 'undefined'
                ? context.user
                : await User.findByPk(userId, { transaction });

            const orgRow =
              organisationId && context.organisation && typeof context.organisation.agentLimit !== 'undefined'
                ? context.organisation
                : organisationId
                  ? await Organisation.findByPk(organisationId, { transaction })
                  : null;

            const instLimit = instanceRow.agentLimit;
            const userLimit = userRow?.agentLimit;
            const orgLimit = orgRow?.agentLimit;

            // Only count a scope if that entity has a configured limit.
            // (Null => unlimited)
            if (instLimit != null) {
              if (instLimit === 0) {
                enforceLimit(0, 0, 'instance', callId);
              } else {
                const instCount = await CallConcurrency.count({ where: { instanceId }, transaction });
                enforceLimit(instLimit, instCount, 'instance', callId);
              }
            }

            if (userLimit != null) {
              if (userLimit === 0) {
                enforceLimit(0, 0, 'user', callId);
              } else {
                const userCount = await CallConcurrency.count({ where: { userId }, transaction });
                enforceLimit(userLimit, userCount, 'user', callId);
              }
            }

            if (organisationId && orgLimit != null) {
              if (orgLimit === 0) {
                enforceLimit(0, 0, 'organisation', callId);
              } else {
                const orgCount = await CallConcurrency.count({
                  where: { organisationId },
                  transaction,
                });
                enforceLimit(orgLimit, orgCount, 'organisation', callId);
              }
            }

            try {
              await CallConcurrency.create(
                { callId, instanceId, userId, organisationId },
                { transaction },
              );
            } catch (e) {
              // If we raced with another SERIALIZABLE tx for the same callId,
              // treat it as idempotent success (row already reserved).
              if (String(e?.original?.code) === '23505') {
                return;
              }
              throw e;
            }
          },
        );
        return;
      } catch (e) {
        lastErr = e;
        const code = e?.parent?.code ?? e?.original?.code;
        const isSerialization =
          code === PG_SERIALIZATION_FAILURE ||
          (e?.name === 'SequelizeDatabaseError' && String(code || '') === PG_SERIALIZATION_FAILURE);
        if (isSerialization && attempt < maxAttempts) {
          logger?.warn?.({ attempt, callId }, 'concurrency reserve serialization retry');
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  async function releaseCall(callId) {
    if (!callId) {
      return;
    }
    await CallConcurrency.destroy({ where: { callId } });
  }

  async function getCounts({ instanceId, userId, organisationId }) {
    const out = {};
    if (instanceId != null) {
      out.instance = await CallConcurrency.count({ where: { instanceId } });
    }
    if (userId != null) {
      out.user = await CallConcurrency.count({ where: { userId } });
    }
    if (organisationId != null) {
      out.organisation = await CallConcurrency.count({
        where: { organisationId },
      });
    }
    return out;
  }

  return {
    reserveForCall,
    releaseCall,
    getCounts,
  };
}
