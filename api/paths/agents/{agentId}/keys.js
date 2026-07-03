import { Agent } from '../../../../lib/database.js';
import { scopeWhereForUser } from '../../../../lib/scope.js';
import { isBuiltinAgentId } from '../../../../lib/builtin-agents.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';

let log;

export default function (logger) {
  log = logger;
  return {
    PUT: agentKeysUpsert,
  };
}

/**
 * PUT /agents/{agentId}/keys — MERGE credential keys by name.
 *
 * Unlike PUT /agents/{agentId} (which replaces the whole `keys` array and so
 * would silently destroy any pre-existing key), this upserts: entries whose
 * `name` already exists are replaced, new names are appended, and keys the
 * caller does not mention are left untouched. It never deletes. This is what a
 * credential-attach flow (e.g. polite.ai's integrations "Enable tools") needs
 * so arming one tool key can't wipe another the agent already carries.
 *
 * `keys` remain write-only: the response echoes only the surviving key NAMES,
 * never their values.
 */
const agentKeysUpsert = async (req, res) => {
  const { agentId } = req.params;
  const { keys } = req.body;

  if (isBuiltinAgentId(agentId)) {
    return res.status(403).send({ message: `Agent ${agentId} is a read-only built-in and cannot be modified` });
  }
  if (!requirePermission(res, 'agent', 'update')) return;
  if (!Array.isArray(keys) || keys.length === 0) {
    return res.status(400).send({ message: 'keys must be a non-empty array of {name, in, value} entries' });
  }
  if (!keys.every((k) => k && typeof k.name === 'string' && k.name.length > 0)) {
    return res.status(400).send({ message: 'every key entry must have a non-empty string name' });
  }

  try {
    const agent = await Agent.findOne({ where: { id: agentId, ...scopeWhereForUser(res.locals.user) } });
    if (!agent) {
      return res.status(404).send({ message: `Agent with ID ${agentId} not found` });
    }
    const existing = Array.isArray(agent.keys) ? agent.keys : [];
    const incoming = new Map(keys.map((k) => [k.name, k]));
    // Keep every existing key the caller did not re-supply, then append the
    // incoming set — so same-name entries are replaced and others preserved.
    const merged = [...existing.filter((k) => !incoming.has(k?.name)), ...keys];
    await agent.update({ keys: merged });
    res.send({ id: agent.id, keyNames: merged.map((k) => k.name) });
  } catch (err) {
    req.log.error(err);
    res.status(400).send({ message: err.message });
  }
};

agentKeysUpsert.apiDoc = {
  summary: 'Upsert (merge) credential keys on an agent by name',
  description:
    'Merges the supplied credential keys into the agent\'s `keys` array by `name`: existing names are '
    + 'replaced, new names appended, and keys not mentioned are left untouched (never deleted). Use this '
    + 'to arm a single tool credential without clobbering other keys the agent already holds — unlike '
    + 'PUT /agents/{agentId}, which replaces the whole array. Key values are write-only; only names are returned.',
  operationId: 'upsertAgentKeys',
  tags: ['Agent'],
  parameters: [
    {
      description: 'ID of the agent to modify',
      in: 'path',
      name: 'agentId',
      required: true,
      schema: { type: 'string' },
    },
  ],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            keys: { $ref: '#/components/schemas/Keys' },
          },
          required: ['keys'],
        },
      },
    },
  },
  responses: {
    200: {
      description: 'The agent id and the resulting key names (values are never returned).',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              keyNames: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    default: {
      description: 'An error occurred',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  },
};
