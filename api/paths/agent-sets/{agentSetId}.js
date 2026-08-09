import { Agent, AgentSet } from '../../../lib/database.js';
import { scopeWhereForUser } from '../../../lib/scope.js';
import { validateSetLabels } from '../../../lib/agent-set-labels.js';
import { reconcileMembers, renderSet, sendAgentSetError } from '../agent-sets.js';
import { requirePermission } from '../../../lib/auth/permissions.js';
import { assertAgentsNotWired, WiredListenerError } from '../../../lib/deployment-guard.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: agentSetGet,
    PUT: agentSetUpdate,
    DELETE: agentSetDelete,
  };
};

const agentSetIdParameter = {
  description: "ID of the agent set",
  in: 'path',
  name: 'agentSetId',
  required: true,
  schema: {
    type: 'string',
    format: 'uuid'
  }
};

const agentSetGet = async (req, res) => {
  if (!requirePermission(res, 'agentSet', 'read')) return;
  const { agentSetId } = req.params;
  try {
    const rendered = await renderSet(agentSetId, res.locals.user);
    if (!rendered) {
      return res.status(404).send({ message: `Agent set with ID ${agentSetId} not found` });
    }
    res.send(rendered);
  }
  catch (err) {
    req.log.error(err, 'fetching agent set');
    res.status(500).send({ message: err.message });
  }
};

agentSetGet.apiDoc = {
  summary: 'Returns an agent set with its full member definitions.',
  operationId: 'getAgentSet',
  tags: ["Agent Sets"],
  parameters: [agentSetIdParameter],
  responses: {
    200: {
      description: 'Agent set. Member `keys` are never returned.',
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/AgentSet'
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

const agentSetUpdate = async (req, res) => {
  if (!requirePermission(res, 'agentSet', 'update')) return;
  const { agentSetId } = req.params;
  const { name, description, agents } = req.body;
  const user = res.locals.user;

  try {
    const set = await AgentSet.findOne({ where: { id: agentSetId, ...scopeWhereForUser(user) } });
    if (!set) {
      return res.status(404).send({ message: `Agent set with ID ${agentSetId} not found` });
    }
    const byLabel = validateSetLabels(agents);
    await AgentSet.sequelize.transaction(async (transaction) => {
      await set.update({
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description })
      }, { transaction });
      const existing = await Agent.findAll({ where: { agentSetId: set.id }, transaction });
      await reconcileMembers({ set, byLabel, existing, user, transaction });
    });
    log.info({ setId: set.id, labels: [...byLabel.keys()] }, 'agent set updated');
    res.send(await renderSet(set.id, user));
  }
  catch (err) {
    sendAgentSetError(req, res, err);
  }
};

agentSetUpdate.apiDoc = {
  summary: 'Updates an agent set as a group.',
  description: `Reconciles the set against the supplied document, matching members by \`label\`:
                existing labels are updated in place (keeping their agent IDs), new labels are created,
                and members whose label is absent from the document are deleted. All \`label:\` references
                (and previously fixed-up \`fromLabel\` annotations) are re-resolved against the new membership.
                The whole operation is transactional: it either fully applies or fails leaving the set unchanged.
                A member's stored functions that reference a write-only key entry (their \`key\` property —
                platform-wired tools such as calendar booking) are PRESERVED even when the incoming member's
                \`functions\` omits them: an incoming function of the same name replaces the stored one, and a
                name listed in the member's \`removeFunctions\` deletes it, but omission alone never strips a
                keyed function. Documents written before such wiring therefore round-trip safely.`,
  operationId: 'updateAgentSet',
  tags: ["Agent Sets"],
  parameters: [agentSetIdParameter],
  requestBody: {
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/AgentSetInput'
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Updated agent set.',
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/AgentSet'
          }
        }
      }
    },
    409: {
      description: 'A member removed by this document still has a phone number or SIP registration listening on it — undeploy first.',
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

const agentSetDelete = async (req, res) => {
  if (!requirePermission(res, 'agentSet', 'delete')) return;
  const { agentSetId } = req.params;
  try {
    const set = await AgentSet.findOne({ where: { id: agentSetId, ...scopeWhereForUser(res.locals.user) } });
    if (!set) {
      return res.status(404).send({ message: `Agent set with ID ${agentSetId} not found` });
    }
    await AgentSet.sequelize.transaction(async (transaction) => {
      const members = await Agent.findAll({ where: { agentSetId: set.id }, transaction });
      // Fail closed: never cascade a live number/registration away with the set.
      await assertAgentsNotWired(members, { transaction });
      await Agent.destroy({ where: { agentSetId: set.id }, transaction });
      await set.destroy({ transaction });
    });
    log.info({ setId: agentSetId }, 'agent set deleted');
    res.status(200).send();
  }
  catch (err) {
    if (err instanceof WiredListenerError) {
      return res.status(err.status).send({ message: err.message });
    }
    req.log.error(err, 'deleting agent set');
    res.status(500).send({ message: err.message });
  }
};

agentSetDelete.apiDoc = {
  summary: 'Deletes an agent set and all of its member agents.',
  operationId: 'deleteAgentSet',
  tags: ["Agent Sets"],
  parameters: [agentSetIdParameter],
  responses: {
    200: {
      description: 'Deleted agent set.',
    },
    409: {
      description: 'A member still has a phone number or SIP registration listening on it — undeploy first.',
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
