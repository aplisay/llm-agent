import { Instance, Agent } from '../../../lib/database.js';
import { scopeWhereForUser } from '../../../lib/scope.js';
import { requirePermission } from '../../../lib/auth/permissions.js';
import handlers from '../../../lib/handlers/index.js';

let log;

export default function (logger) {
  log = logger;
  return {
    DELETE: listenerDelete,
    PATCH: listenerRepoint,
  };
};

const listenerDelete = async (req, res) => {
  if (!requirePermission(res, 'agent', 'deploy')) return;
  const { listenerId } = req.params;
  req.log.info({ id: listenerId }, 'instance delete called');

  try {
    const deleted = await Instance.destroy({
      where: {
        id: listenerId,
        ...scopeWhereForUser(res.locals.user),
      },
    });

    if (!deleted) {
      return res.status(404).send({ error: `Listener with ID ${listenerId} not found` });
    }

    res.status(200).send();
  }
  catch (err) {
    req.log.error(err, 'deleting instance');
    res.status(404).send(err);
  }
};

/**
 * Repoint a listener at a different agent, in place.
 *
 * Agent config is resolved PER CALL SESSION from `Instance.agentId`
 * (`Handler.fromInstance`), so this is a pure row update: the listener id,
 * any bound phone number / registration, and carrier routing are untouched;
 * calls in progress finish on the handler they already hold and the next
 * call answers as the new agent. Used by the polite-ai publish flow to merge
 * draft-bound deployments onto the live twin ("additive merge") — but it is
 * a general primitive: any same-organisation agent on the same transport is
 * a valid target.
 */
const listenerRepoint = async (req, res) => {
  if (!requirePermission(res, 'agent', 'deploy')) return;
  const { listenerId } = req.params;
  const { agentId } = req.body;
  try {
    const instance = await Instance.findOne({
      where: { id: listenerId, ...scopeWhereForUser(res.locals.user) },
    });
    if (!instance) {
      return res.status(404).send({ message: `Listener with ID ${listenerId} not found` });
    }
    const agent = await Agent.findOne({
      where: { id: agentId, ...scopeWhereForUser(res.locals.user) },
    });
    if (!agent) {
      return res.status(404).send({ message: `Agent with ID ${agentId} not found` });
    }
    // The instance's transport is fixed at activation (`Instance.type`); the
    // target agent's model must route through the same telephony handler
    // (ultravox delegates its telephony leg to jambonz, matching activate()).
    const Handler = (await handlers()).getHandler(agent.modelName);
    if (!Handler) {
      return res.status(400).send({ message: `No handler for model ${agent.modelName}` });
    }
    const expectedType = Handler.telephonyHandler || Handler.name;
    if (![expectedType, Handler.name].includes(instance.type)) {
      return res.status(412).send({
        message: `Not supported: listener transport is ${instance.type} but agent ${agentId} uses ${expectedType}`,
      });
    }
    await instance.update({ agentId: agent.id });
    log.info({ id: listenerId, agentId: agent.id }, 'listener repointed');
    res.send({ id: instance.id, agentId: agent.id });
  }
  catch (err) {
    req.log.error(err, 'repointing listener');
    res.status(500).send({ message: err.message });
  }
};

listenerRepoint.apiDoc = {
  summary: 'Repoints a listener at a different agent without tearing it down.',
  description: `Moves the listener (and any phone number or SIP registration bound to it) to another
                agent in the same organisation. The listener id and endpoint binding are unchanged;
                calls in progress complete on the previous agent and subsequent calls answer as the new
                one. The target agent must use the same telephony transport as the listener.`,
  operationId: 'updateListenerById',
  tags: ["Listeners"],
  parameters: [
    {
      description: "ID of the listener to repoint",
      in: 'path',
      name: 'listenerId',
      required: true,
      schema: {
        type: 'string'
      }
    }
  ],
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
              description: 'Agent that should answer this listener from now on'
            }
          }
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Repointed listener.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              agentId: { type: 'string', format: 'uuid' }
            }
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

listenerDelete.apiDoc = {
  summary: 'Deletes a listener',
  operationId: 'deleteListenerById',
  tags: ["Listeners"],
  parameters: [
    {
      description: "ID of the listener to delete",
      in: 'path',
      name: 'listenerId',
      required: true,
      schema: {
        type: 'string'
      }
    }
  ],
  responses: {
    200: {
      description: 'Deleted Listener.',
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


