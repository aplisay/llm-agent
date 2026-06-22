/**
 * POST /agent-sets/from-agent — promote a legacy set-less agent into a brand-new
 * single-member agent set, WITHOUT duplicating it.
 *
 * Unlike createAgentSet (which mints fresh member agents from a document, matching
 * by label), this MOVES the existing agent into the new set: it sets the agent's
 * `agentSetId` and `label` in place, so the agent keeps its id — and therefore its
 * deployments, phone-number assignments and call history all stay attached. The
 * agent must not already belong to a set. Transactional: it either fully applies
 * (set created + agent moved) or rolls back.
 */
import { Agent, AgentSet } from '../../../lib/database.js';
import { scopeWhereForUser } from '../../../lib/scope.js';
import { renderSet, sendAgentSetError } from '../agent-sets.js';

let log;

export default function (logger) {
  log = logger;
  return { POST: agentSetFromAgent };
}

/** A set-member label (unique within the set; alphanumeric, may contain - and _). */
function labelFor(name) {
  const s = String(name || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || 'agent';
}

const agentSetFromAgent = async (req, res) => {
  const { agentId, name } = req.body;
  const user = res.locals.user;

  try {
    const set = await AgentSet.sequelize.transaction(async (transaction) => {
      const agent = await Agent.findOne({
        where: { id: agentId, ...scopeWhereForUser(user) },
        transaction,
      });
      if (!agent) {
        const err = new Error(`Agent with ID ${agentId} not found`);
        err.statusCode = 404;
        throw err;
      }
      if (agent.agentSetId) {
        const err = new Error('Agent is already a member of a set');
        err.statusCode = 409;
        throw err;
      }
      const created = await AgentSet.create({
        name: name || agent.name || 'Agent set',
        userId: user.id,
        organisationId: user.organisationId ?? null,
      }, { transaction });
      await agent.update(
        { agentSetId: created.id, label: labelFor(name || agent.name) },
        { transaction },
      );
      return created;
    });
    log.info({ setId: set.id, agentId }, 'agent set created from existing agent');
    res.send(await renderSet(set.id, user));
  }
  catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).send({ message: err.message });
    }
    sendAgentSetError(req, res, err);
  }
};

agentSetFromAgent.apiDoc = {
  summary: 'Promotes an existing set-less agent into a new single-member set.',
  description: `Creates a new agent set and MOVES the given existing agent into it — the agent keeps its id
                (and therefore its deployments and call history); it is not duplicated. The agent must not
                already belong to a set.`,
  operationId: 'createAgentSetFromAgent',
  tags: ["Agent Sets"],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['agentId'],
          properties: {
            agentId: {
              type: 'string',
              format: 'uuid',
              description: 'Id of the existing set-less agent to promote.'
            },
            name: {
              type: 'string',
              description: 'Optional name for the new set (defaults to the agent name).'
            }
          }
        }
      }
    }
  },
  responses: {
    200: {
      description: 'The created agent set, now containing the promoted agent.',
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/AgentSet'
          }
        }
      }
    },
    409: {
      description: 'The agent already belongs to a set.',
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/Error'
          }
        }
      }
    },
    default: {
      description: 'An error occurred',
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/Error'
          }
        }
      }
    }
  }
};
