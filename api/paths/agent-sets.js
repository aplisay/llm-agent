import { Agent, AgentSet } from '../../lib/database.js';
import { scopeWhereForUser } from '../../lib/scope.js';
import {
  validateSetLabels,
  fixupLabelReferences,
  validateAgentTargets,
  AgentSetValidationError
} from '../../lib/agent-set-labels.js';

let log;

export default function (logger) {
  log = logger;
  return {
    POST: agentSetCreate,
    GET: agentSetList
  };
};

const MEMBER_FIELDS = ['name', 'description', 'modelName', 'prompt', 'options', 'functions', 'keys', 'type'];

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
 */
export async function reconcileMembers({ set, byLabel, existing = [], user, transaction }) {
  const existingByLabel = new Map(existing.map((agent) => [agent.label, agent]));

  // Remove members whose label is no longer in the document
  for (const agent of existing) {
    if (!byLabel.has(agent.label)) {
      await agent.destroy({ transaction });
    }
  }

  // Build new rows / pair up existing ones. Rows are built before fixup so
  // every member has a UUID for the label map.
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

  const labelMap = new Map(members.map(({ label, agent }) => [label, agent.id]));
  const membersById = new Map(members.map(({ agent, def }) => [agent.id, { type: defaultType(def) }]));

  const lookupAgent = (agentId) => Agent.findOne({
    where: { id: agentId, ...scopeWhereForUser(user) },
    transaction
  });

  for (const { label, def, agent } of members) {
    for (const field of MEMBER_FIELDS) {
      if (def[field] !== undefined) {
        agent[field] = field === 'type' ? defaultType(def) : def[field];
      }
    }
    if (agent.functions) {
      fixupLabelReferences(agent.functions, labelMap, label);
      agent.changed('functions', true);
      await validateAgentTargets(agent.functions, { membersById, lookupAgent, owningLabel: label });
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
  if (err.name === 'SequelizeValidationError') {
    return res.status(400).send({ message: err.errors.map((e) => e.message).join('; ') });
  }
  req.log.error(err, 'agent set operation failed');
  return res.status(500).send({ message: err.message });
}

const agentSetCreate = async (req, res) => {
  const { name, description, agents } = req.body;
  const user = res.locals.user;

  try {
    const byLabel = validateSetLabels(agents);
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
                retained as \`fromLabel\` so the document can be round-tripped through PUT).`,
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
