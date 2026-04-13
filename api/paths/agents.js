import { Agent, Op } from '../../lib/database.js';

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
  let { name, description, modelName, prompt, options, functions, keys } = req.body;
  let { id: userId, organisationId } = res.locals.user;
  let agent = Agent.build({ name, description, modelName, prompt, options, functions, keys, userId, organisationId });

  log.info({ modelName, prompt, options, functions, userId, organisationId}, 'create API call');

  try {
    await agent.save();
    res.send({ ...agent.dataValues, keys: undefined });
  }
  catch (err) {
    req.log.error(err, 'DATABASE ERROR: creating agent');
    if (err.name === 'SequelizeValidationError') {
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
            prompt: {
              $ref: '#/components/schemas/Prompt'
            },
            options: {
              $ref: '#/components/schemas/AgentOptions'
            },
            functions: {
              $ref: '#/components/schemas/Functions'
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
  let { id: userId, organisationId } = res.locals.user;
  const scopeWhere = organisationId
    ? { [Op.or]: [{ userId }, { organisationId }] }
    : { userId };

  const limitRaw = req.query.limit;
  const usePaging = limitRaw !== undefined && limitRaw !== null && String(limitRaw).length > 0;

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

    const listAttrs = ['id', 'name', 'description', 'modelName', 'createdAt', 'updatedAt'];
    const order = [['updatedAt', 'DESC'], ['name', 'ASC'], ['id', 'ASC']];

    if (!usePaging) {
      const agents = await Agent.findAll({
        where,
        attributes: listAttrs,
        order
      });
      return res.send(agents);
    }

    const startOffset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
    const size = Math.min(200, Math.max(1, parseInt(String(limitRaw), 10) || 50));

    const { count, rows: agents } = await Agent.findAndCountAll({
      where,
      attributes: listAttrs,
      order,
      limit: size,
      offset: startOffset
    });

    const nextOffset = count > startOffset + agents.length ? startOffset + size : null;
    return res.send({ agents, nextOffset });
  }
  catch (err) {
    req.log.error(err, 'listing agents');
    res.status(500).send(err);
  }
});
agentList.apiDoc = {
  summary: 'Returns a list of all this user\'s agents.',
  description:
    'Summary index only: id, name, description, modelName, and timestamps; use GET /agents/{agentId} for the full agent. ' +
    'Without query parameter `limit`, the response is a JSON array (legacy). With `limit`, the response is `{ agents, nextOffset }` ' +
    '(same pagination style as phone-endpoints / trunks).',
  operationId: 'listAgents',
  tags: ["Agent"],
  parameters: [
    {
      in: 'query',
      name: 'limit',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 200 },
      description: 'When set, paginates and returns `{ agents, nextOffset }` instead of a bare array.'
    },
    {
      in: 'query',
      name: 'offset',
      required: false,
      schema: { type: 'integer', minimum: 0, default: 0 },
      description: 'Row offset when using `limit`.'
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
      description: 'List of agent summaries for indexing (array if `limit` omitted; object if `limit` set).',
      content: {
        'application/json': {
          schema: {
            oneOf: [
              {
                type: 'array',
                items: {
                  $ref: '#/components/schemas/AgentListItem'
                }
              },
              {
                type: 'object',
                properties: {
                  agents: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/AgentListItem' }
                  },
                  nextOffset: {
                    type: 'integer',
                    nullable: true,
                    description: 'Pass as `offset` for the next page, or null when done.'
                  }
                },
                required: ['agents', 'nextOffset']
              }
            ]
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




