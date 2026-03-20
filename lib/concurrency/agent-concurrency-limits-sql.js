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
 * @param {import('sequelize').ModelStatic<any>} deps.InstanceConcurrency
 * @param {import('sequelize').ModelStatic<any>} deps.UserConcurrency
 * @param {import('sequelize').ModelStatic<any>} deps.OrganisationConcurrency
 * @param {{ warn: Function, error: Function }} deps.logger
 */
export function createSqlAgentConcurrencyLimits(deps) {
  const {
    sequelize,
    Transaction,
    Instance,
    User,
    Organisation,
    InstanceConcurrency,
    UserConcurrency,
    OrganisationConcurrency,
    logger,
  } = deps;

  /**
   * @param {number | null | undefined} limit
   * @param {boolean} alreadyTracked
   * @param {number} currentCount
   * @param {'instance'|'user'|'organisation'} scope
   * @param {string} callId
   */
  function enforceLimit(limit, alreadyTracked, currentCount, scope, callId) {
    if (limit == null) {
      return;
    }
    if (limit === 0) {
      if (!alreadyTracked) {
        throw new AgentConcurrencyLimitExceededError(
          scope,
          `agentLimit is 0 for ${scope}: no concurrent agents allowed`,
          { limit: 0, current: currentCount, callId },
        );
      }
      return;
    }
    if (limit > 0 && !alreadyTracked && currentCount >= limit) {
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
  async function reserveForCall(call) {
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
            const [instRow, userRow, orgRow, ic, uc, oc] = await Promise.all([
              Instance.findByPk(instanceId, { transaction }),
              userId ? User.findByPk(userId, { transaction }) : Promise.resolve(null),
              organisationId
                ? Organisation.findByPk(organisationId, { transaction })
                : Promise.resolve(null),
              InstanceConcurrency.findByPk(callId, { transaction }),
              userId ? UserConcurrency.findByPk(callId, { transaction }) : Promise.resolve(null),
              organisationId
                ? OrganisationConcurrency.findByPk(callId, { transaction })
                : Promise.resolve(null),
            ]);

            if (!instRow) {
              throw new Error(`Instance not found: ${instanceId}`);
            }

            // Fully idempotent: already have all relevant rows
            const needUser = Boolean(userId);
            const needOrg = Boolean(organisationId);
            if (
              ic &&
              (!needUser || uc) &&
              (!needOrg || oc)
            ) {
              return;
            }

            const instLimit = instRow.agentLimit;
            const userLimit = userRow?.agentLimit;
            const orgLimit = orgRow?.agentLimit;

            const instCount = await InstanceConcurrency.count({
              where: { instanceId },
              transaction,
            });
            enforceLimit(instLimit, Boolean(ic), instCount, 'instance', callId);

            if (userId) {
              const userCount = await UserConcurrency.count({
                where: { userId },
                transaction,
              });
              enforceLimit(userLimit, Boolean(uc), userCount, 'user', callId);
            }

            if (organisationId) {
              const orgCount = await OrganisationConcurrency.count({
                where: { organisationId },
                transaction,
              });
              enforceLimit(orgLimit, Boolean(oc), orgCount, 'organisation', callId);
            }

            await InstanceConcurrency.upsert(
              { callId, instanceId },
              { transaction },
            );
            if (userId) {
              await UserConcurrency.upsert({ callId, userId }, { transaction });
            }
            if (organisationId) {
              await OrganisationConcurrency.upsert(
                { callId, organisationId },
                { transaction },
              );
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
    await Promise.all([
      InstanceConcurrency.destroy({ where: { callId } }),
      UserConcurrency.destroy({ where: { callId } }),
      OrganisationConcurrency.destroy({ where: { callId } }),
    ]);
  }

  async function getCounts({ instanceId, userId, organisationId }) {
    const out = {};
    if (instanceId != null) {
      out.instance = await InstanceConcurrency.count({ where: { instanceId } });
    }
    if (userId != null) {
      out.user = await UserConcurrency.count({ where: { userId } });
    }
    if (organisationId != null) {
      out.organisation = await OrganisationConcurrency.count({
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
