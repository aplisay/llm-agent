import { Instance, Agent } from '../../../lib/database.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    GET: instanceGet
  };
};

const instanceGet = (async (req, res) => {
  let { instanceId } = req.query;

  log.debug({ instanceId }, 'instanceGet');

  // By id only. The former `?number=` form resolved an instance from a bare
  // number with no trunk, which is not a question an inbound call may ask:
  // a number resolves through GET /api/agent-db/phone-endpoints?number=&trunkId=
  // to its endpoint, and the endpoint names the instance.
  if (!instanceId) {
    return res.status(400).send({ error: 'instanceId query parameter is required' });
  }

  try {
    let instance, agent;

    instance = await Instance.findByPk(instanceId, { include: Agent });
    agent = instance?.Agent;

    if (!instance) {
      log.error({ instanceId }, 'instance not found');
      return res.status(404).send({ error: 'Instance not found' });
    }

    if (!agent) {
      log.error({ instanceId }, 'agent not found');
      return res.status(404).send({ error: 'Agent not found for this instance' });
    }

    // Return the same structure for both cases
    const result = {
      ...instance.toJSON(),
      Agent: agent
    };

    res.send(result);
  }
  catch (err) {
    log.error(err, 'error fetching instance');
    res.status(500).send({ error: 'Internal server error' });
  }
});

instanceGet.apiDoc = {
  summary: 'Returns an instance by ID with its associated agent.',
  operationId: 'getInstance',
  tags: ["Agent"],
  parameters: [
    {
      name: 'instanceId',
      in: 'query',
      required: false,
      schema: {
        type: 'string',
        format: 'uuid'
      },
      description: 'The ID of the instance to retrieve'
    },
  ],
  responses: {
    200: {
      description: 'Instance found and returned.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                format: 'uuid'
              },
              agentId: {
                type: 'string',
                format: 'uuid'
              },
              number: {
                type: 'string'
              },
              streamUrl: {
                type: 'string'
              },
              key: {
                type: 'string'
              },
              metadata: {
                type: 'object'
              },
              createdAt: {
                type: 'string',
                format: 'date-time'
              },
              updatedAt: {
                type: 'string',
                format: 'date-time'
              },
              Agent: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    format: 'uuid'
                  },
                  name: {
                    type: 'string'
                  },
                  description: {
                    type: 'string'
                  },
                  modelName: {
                    type: 'string'
                  },
                  prompt: {
                    type: 'string'
                  },
                  options: {
                    type: 'object'
                  },
                  functions: {
                    type: 'array'
                  },
                  mcpServers: {
                    type: 'array'
                  },
                  keys: {
                    type: 'array'
                  },
                  userId: {
                    type: 'string',
                    format: 'uuid'
                  },
                  organisationId: {
                    type: 'string',
                    format: 'uuid'
                  },
                  createdAt: {
                    type: 'string',
                    format: 'date-time'
                  },
                  updatedAt: {
                    type: 'string',
                    format: 'date-time'
                  }
                }
              }
            }
          }
        }
      }
    },
    400: {
      description: 'Bad request - missing instanceId parameter',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    404: {
      description: 'Instance not found',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    }
  }
};
