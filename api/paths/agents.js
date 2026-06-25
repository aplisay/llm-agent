import { Agent, Op } from '../../lib/database.js';
import { scopeWhereForUser } from '../../lib/scope.js';
import { validateAgentTargets, AgentSetValidationError } from '../../lib/agent-set-labels.js';
import { listBuiltinAgentSummaries } from '../../lib/builtin-agents.js';
import { requirePermission } from '../../lib/auth/permissions.js';
import { isModelAllowed, allowedModelsWhere } from '../../lib/auth/model-access.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    POST: agentCreate,
    GET: agentList
  };
};

const agentCreate = (async (req, res) => {
  let { name, description, modelName, prompt, options, functions, mcpServers, keys, type } = req.body;
  let { id: userId, organisationId } = res.locals.user;
  // RBAC: a single `agent` resource — text-vs-audio is NOT a separate permission.
  if (!requirePermission(res, 'agent', 'create')) return;
  // R1: the chosen model must be within this principal's effective allow-list.
  if (!isModelAllowed(modelName, res.locals.user?._allowedModels)) {
    return res.status(403).json({ message: 'model_not_permitted', detail: `Model ${modelName} is not permitted for your account.` });
  }
  // Default the agent type from the model's handler prefix when not given explicitly
  type = type ?? (typeof modelName === 'string' && modelName.startsWith('text:') ? 'text' : 'interactive-audio');
  let agent = Agent.build({ name, description, modelName, prompt, options, functions, mcpServers, keys, type, userId, organisationId });

  log.info({ modelName, prompt, options, functions, mcpServers, userId, organisationId, type }, 'create API call');

  try {
    // Static transfer_agent/subagent targets must reference accessible agents of the right type
    functions && await validateAgentTargets(functions, {
      lookupAgent: (agentId) => Agent.findOne({ where: { id: agentId, ...scopeWhereForUser(res.locals.user) } })
    });
    await agent.save();
    res.send({ ...agent.dataValues, keys: undefined });
  }
  catch (err) {
    req.log.error(err, 'DATABASE ERROR: creating agent');
    if (err instanceof AgentSetValidationError) {
      res.status(400).send({ message: err.message });
    }
    else if (err.name === 'SequelizeValidationError') {
      res.status(400).send(err.errors.map((e) => e.message));
    }
    else {
      res.status(500).send(err);
    }

  }
});

agentCreate.apiDoc = {
  summary: 'Creates an agent.',
  operationId: 'createAgent',
  tags: ["Agent"],
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: "object",
          properties: {
            name: {
              type: "string"
            },
            description: {
              type: "string"
            },
            modelName: {
              $ref: '#/components/schemas/ModelName'
            },
            type: {
              $ref: '#/components/schemas/AgentType'
            },
            prompt: {
              $ref: '#/components/schemas/Prompt'
            },
            options: {
              $ref: '#/components/schemas/AgentOptions'
            },
            functions: {
              $ref: '#/components/schemas/Functions'
            },
            mcpServers: {
              $ref: '#/components/schemas/McpServers'
            },
            keys: {
              $ref: '#/components/schemas/Keys'
            }
          },
          required: ['modelName', 'prompt']
        }
      }
    }
  },
  callbacks: {
    webhooks: {
      progressCallback: {
        post: {
          requestBody: {
            description: `This is delivered as the JSON body of a callback to callbackUrl
                          but more usefully in JSON encoded websocket messages on \`socket\``,
            content: {
              'application/json': {
                schema: {
                  $ref: "#/components/schemas/Progress"
                }
              }
            }
          },
          responses: {
            "200": {
              description: 'Return a 200 status to indicate that the data was received successfully'
            }
          }
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Created Agent.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            description: 'Agent information',
            properties: {
              modelName: {
                $ref: '#/components/schemas/ModelName'
              },
              prompt: {
                $ref: '#/components/schemas/Prompt'
              },
              options: {
                $ref: '#/components/schemas/AgentOptions'
              },
              functions: {
                $ref: '#/components/schemas/Functions'
              },
              mcpServers: {
                $ref: '#/components/schemas/McpServers'
              },
              keys: {
                $ref: '#/components/schemas/Keys'
              }
            },
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



/** Strip LIKE wildcards from user search input (avoids accidental pattern expansion). */
function sanitizeAgentSearchToken(raw) {
  return String(raw ?? '').trim().replace(/[%_\\]/g, '');
}

const agentList = (async (req, res) => {
  const scopeWhere = scopeWhereForUser(res.locals.user);

  const limitRaw = req.query.limit;
  const startOffset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
  const size = Math.min(200, Math.max(1, parseInt(String(limitRaw ?? 50), 10) || 50));

  try {
    const searchRaw = sanitizeAgentSearchToken(req.query.search);
    const searchField = String(req.query.searchField || 'all').toLowerCase();
    const validField = searchField === 'name' || searchField === 'model' ? searchField : 'all';

    let where = scopeWhere;
    if (searchRaw) {
      const pattern = `%${searchRaw}%`;
      let searchWhere;
      if (validField === 'name') {
        searchWhere = { name: { [Op.iLike]: pattern } };
      } else if (validField === 'model') {
        searchWhere = { modelName: { [Op.iLike]: pattern } };
      } else {
        searchWhere = {
          [Op.or]: [
            { name: { [Op.iLike]: pattern } },
            { modelName: { [Op.iLike]: pattern } }
          ]
        };
      }
      where = { [Op.and]: [scopeWhere, searchWhere] };
    }

    // R1 — confine the listing to models in the principal's effective allow-list
    // (in SQL, so pagination/`next` stay correct). Builtins are platform tooling
    // and are intentionally NOT model-gated.
    const modelWhere = allowedModelsWhere(res.locals.user?._allowedModels, Op);
    if (modelWhere) where = { [Op.and]: [where, modelWhere] };

    const listAttrs = ['id', 'name', 'description', 'modelName', 'createdAt', 'updatedAt'];
    const order = [['updatedAt', 'DESC'], ['name', 'ASC'], ['id', 'ASC']];

    const { count, rows: agents } = await Agent.findAndCountAll({
      where,
      attributes: listAttrs,
      order,
      limit: size,
      offset: startOffset
    });

    const next = count > startOffset + agents.length ? startOffset + size : false;
    // Read-only built-in agents (available to every tenant) sit at the top of the first page.
    const builtins = startOffset === 0
      ? listBuiltinAgentSummaries().filter((b) => {
        // R1/F7 — built-ins gated by their `builtin:<id>` access prefix.
        if (!isModelAllowed(b.id, res.locals.user?._allowedModels)) return false;
        if (!searchRaw) return true;
        const p = searchRaw.toLowerCase();
        const inName = (b.name || '').toLowerCase().includes(p);
        const inModel = (b.modelName || '').toLowerCase().includes(p);
        if (validField === 'name') return inName;
        if (validField === 'model') return inModel;
        return inName || inModel;
      })
      : [];
    return res.send({ agents: [...builtins, ...agents], next });
  }
  catch (err) {
    req.log.error(err, 'listing agents');
    res.status(500).send(err);
  }
});
agentList.apiDoc = {
  summary: 'Returns a paginated list of this user\'s agents.',
  description:
    'Summary index only: id, name, description, modelName, and timestamps; use GET /agents/{agentId} for the full agent. ' +
    'Response shape matches GET /calls and GET /agents/{agentId}/calls: `{ agents, next }` where `next` is the offset for the next page or `false` when done. Default `limit` is 50.',
  operationId: 'listAgents',
  tags: ["Agent"],
  parameters: [
    {
      in: 'query',
      name: 'limit',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      description: 'Page size (default 50).'
    },
    {
      in: 'query',
      name: 'offset',
      required: false,
      schema: { type: 'integer', minimum: 0, default: 0 },
      description: 'Row offset for this page.'
    },
    {
      in: 'query',
      name: 'search',
      required: false,
      schema: { type: 'string' },
      description: 'Case-insensitive substring filter on name and/or model (see `searchField`).'
    },
    {
      in: 'query',
      name: 'searchField',
      required: false,
      schema: { type: 'string', enum: ['all', 'name', 'model'], default: 'all' },
      description: 'Whether `search` applies to name only, model only, or both.'
    }
  ],
  responses: {
    200: {
      description: 'Paginated agent summaries: `{ agents, next }` (same pattern as GET /calls).',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              agents: {
                type: 'array',
                items: { $ref: '#/components/schemas/AgentListItem' }
              },
              next: {
                description: 'Next `offset` for pagination, or `false` when there are no more results.',
                oneOf: [{ type: 'integer' }, { type: 'boolean', enum: [false] }]
              }
            },
            required: ['agents', 'next']
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




