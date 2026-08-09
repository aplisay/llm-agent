import { Agent, AgentSet } from '../../lib/database.js';
import { scopeWhereForUser } from '../../lib/scope.js';
import { requirePermission } from '../../lib/auth/permissions.js';
import {
  validateSetLabels,
  fixupLabelReferences,
  validateAgentTargets,
  AgentSetValidationError
} from '../../lib/agent-set-labels.js';
import { mergeMemberFunctions } from '../../lib/agent-set-functions.js';
import { assertAgentsNotWired, WiredListenerError } from '../../lib/deployment-guard.js';

let log;

export default function (logger) {
  log = logger;
  return {
    POST: agentSetCreate,
    GET: agentSetList
  };
};

const MEMBER_FIELDS = ['name', 'description', 'modelName', 'prompt', 'promptMetadata', 'options', 'functions', 'mcpServers', 'keys', 'type'];

/** Default the agent type from the model name's handler prefix when not given explicitly. */
export function defaultType(def) {
  return def.type
    ?? (typeof def.modelName === 'string' && def.modelName.startsWith('text:') ? 'text' : 'interactive-audio');
}

/** Serialise a member agent for API responses (no keys, ever). */
export function renderMember(agent) {
  return { ...agent.dataValues, keys: undefined };
}

/** Fetch and serialise a full agent set with its members. */
export async function renderSet(setId, user) {
  const set = await AgentSet.findOne({
    where: { id: setId, ...scopeWhereForUser(user) },
    include: [{ model: Agent, as: 'agents' }],
    order: [[{ model: Agent, as: 'agents' }, 'label', 'ASC']]
  });
  if (!set) {
    return null;
  }
  return {
    id: set.id,
    name: set.name,
    description: set.description,
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
    agents: (set.agents || []).map(renderMember)
  };
}

/**
 * Create (or, for updateAgentSet, reconcile) the members of a set inside a
 * transaction: build/refresh rows, resolve label references against the new
 * membership, validate cross-references, then save.
 *
 * Member `functions` are merged, not blindly replaced: stored functions that
 * reference a write-only key entry (platform-wired tools) survive a document
 * that omits them, and are deleted only via the member's `removeFunctions`
 * list (see lib/agent-set-functions.js).
 */
export async function reconcileMembers({ set, byLabel, existing = [], user, transaction, patch = false, removeLabels = [] }) {
  const existingByLabel = new Map(existing.map((agent) => [agent.label, agent]));
  const removeSet = new Set(removeLabels);

  // Deletion.
  //  - replace mode (default): full-state reconcile — destroy any existing
  //    member whose label is no longer in the document.
  //  - patch mode: never delete by omission — only destroy members whose label
  //    was explicitly listed in `removeLabels`.
  const toRemove = existing.filter((agent) =>
    patch ? removeSet.has(agent.label) : !byLabel.has(agent.label));
  // Fail closed: a member still answering a number/registration must be
  // undeployed explicitly first — destroying it would cascade the listener
  // away and silently disconnect the endpoint. This also turns an
  // accidentally-truncated full-document update into a loud 409 instead of
  // a silent outage.
  await assertAgentsNotWired(toRemove, { transaction });
  for (const agent of toRemove) {
    await agent.destroy({ transaction });
  }

  // Build new rows / pair up existing ones. Rows are built before fixup so
  // every member has a UUID for the label map. In replace mode `byLabel` is the
  // whole set; in patch mode it is only the subset being upserted.
  const members = [...byLabel.entries()].map(([label, def]) => ({
    label,
    def,
    agent: existingByLabel.get(label) || Agent.build({
      label,
      agentSetId: set.id,
      userId: user.id,
      organisationId: user.organisationId ?? null,
      type: defaultType(def)
    })
  }));

  // `label:` references and in-set target-type checks must resolve against the
  // WHOLE resulting set. In patch mode that includes existing members left
  // untouched, so seed the maps with them (minus any being removed) before
  // overlaying the members written this call. In replace mode the document IS
  // the whole set, so these seeds stay empty and behaviour is unchanged.
  const removedIds = new Set(toRemove.map((a) => a.id));
  const labelMap = new Map();
  const membersById = new Map();
  if (patch) {
    for (const agent of existing) {
      if (removedIds.has(agent.id)) continue;
      labelMap.set(agent.label, agent.id);
      membersById.set(agent.id, { type: agent.type || 'interactive-audio' });
    }
  }
  for (const { label, agent } of members) labelMap.set(label, agent.id);
  for (const { agent, def } of members) membersById.set(agent.id, { type: defaultType(def) });

  const lookupAgent = (agentId) => Agent.findOne({
    where: { id: agentId, ...scopeWhereForUser(user) },
    transaction
  });

  for (const { label, def, agent } of members) {
    // `functions` is merged, never blindly replaced: keyed (platform-wired)
    // functions on the stored row survive a document that omits them, and a
    // member's `removeFunctions` deletes stored functions by name — see
    // lib/agent-set-functions.js. Capture the stored value before the copy.
    const priorFunctions = agent.isNewRecord ? undefined : agent.functions;
    const mergedFunctions = mergeMemberFunctions(priorFunctions, def.functions, def.removeFunctions);
    for (const field of MEMBER_FIELDS) {
      if (def[field] !== undefined) {
        agent[field] = field === 'type' ? defaultType(def) : def[field];
      }
    }
    if (mergedFunctions !== undefined) {
      agent.functions = mergedFunctions;
    }
    if (agent.functions || agent.options?.bridgedTransferToAgent) {
      fixupLabelReferences(agent.functions || [], labelMap, label, agent.options);
      agent.functions && agent.changed('functions', true);
      agent.options?.bridgedTransferToAgent && agent.changed('options', true);
      await validateAgentTargets(agent.functions || [], { membersById, lookupAgent, owningLabel: label, options: agent.options });
    }
  }
  for (const { agent } of members) {
    await agent.save({ transaction });
  }
  return members;
}

export function sendAgentSetError(req, res, err) {
  if (err instanceof AgentSetValidationError) {
    return res.status(400).send({ message: err.message });
  }
  if (err instanceof WiredListenerError) {
    return res.status(err.status).send({ message: err.message });
  }
  if (err.name === 'SequelizeValidationError') {
    return res.status(400).send({ message: err.errors.map((e) => e.message).join('; ') });
  }
  req.log.error(err, 'agent set operation failed');
  return res.status(500).send({ message: err.message });
}

const agentSetCreate = async (req, res) => {
  if (!requirePermission(res, 'agentSet', 'create')) return;
  const { name, description, agents } = req.body;
  const user = res.locals.user;

  try {
    // An EMPTY set may be created (a placeholder a builder session then fills
    // in) — but only on create: PUT keeps requiring a non-empty document so a
    // truncated update can never silently wipe a team's members.
    const byLabel = Array.isArray(agents) && agents.length ? validateSetLabels(agents) : new Map();
    const set = await AgentSet.sequelize.transaction(async (transaction) => {
      const set = await AgentSet.create({
        name,
        description,
        userId: user.id,
        organisationId: user.organisationId ?? null
      }, { transaction });
      await reconcileMembers({ set, byLabel, user, transaction });
      return set;
    });
    log.info({ setId: set.id, labels: [...byLabel.keys()] }, 'agent set created');
    res.send(await renderSet(set.id, user));
  }
  catch (err) {
    sendAgentSetError(req, res, err);
  }
};

agentSetCreate.apiDoc = {
  summary: 'Creates a set of agents from a single document.',
  description: `Creates a group of agents as a single unit. Each member carries a shortform \`label\`
                (unique within the set). Members may reference each other in \`transfer_agent\` and
                \`subagent\` builtin functions using \`{"source": "static", "from": "label:<label>"}\`;
                these references are fixed up to the real agent UUIDs on creation (the original label is
                retained as \`fromLabel\` so the document can be round-tripped through PUT).
                \`agents\` may be an empty array on create only — a placeholder set to be filled in by a
                later update; PUT always requires a non-empty document.`,
  operationId: 'createAgentSet',
  tags: ["Agent Sets"],
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
      description: 'Created agent set, with member label references resolved to agent IDs.',
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

const agentSetList = async (req, res) => {
  if (!requirePermission(res, 'agentSet', 'read')) return;
  try {
    const sets = await AgentSet.findAll({
      where: scopeWhereForUser(res.locals.user),
      include: [{
        model: Agent,
        as: 'agents',
        attributes: ['id', 'label', 'name', 'modelName', 'type']
      }],
      order: [['updatedAt', 'DESC']]
    });
    res.send({
      agentSets: sets.map((set) => ({
        id: set.id,
        name: set.name,
        description: set.description,
        createdAt: set.createdAt,
        updatedAt: set.updatedAt,
        agents: set.agents
      }))
    });
  }
  catch (err) {
    req.log.error(err, 'listing agent sets');
    res.status(500).send(err);
  }
};

agentSetList.apiDoc = {
  summary: 'Returns a list of this user\'s agent sets.',
  description: 'Summary index: each set lists member agents by id, label, name, modelName and type. Use GET /agent-sets/{agentSetId} for full member definitions.',
  operationId: 'listAgentSets',
  tags: ["Agent Sets"],
  responses: {
    200: {
      description: 'Agent set summaries.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              agentSets: {
                type: 'array',
                items: {
                  $ref: '#/components/schemas/AgentSetListItem'
                }
              }
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
