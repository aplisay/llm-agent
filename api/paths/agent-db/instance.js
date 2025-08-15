import { Instance, Agent, PhoneNumber } from '../../../lib/database.js';

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
  let { instanceId, number } = req.query;

  log.debug({ instanceId, number }, 'instanceGet');

  if (!instanceId && !number) {
    return res.status(400).send({ error: 'Either instanceId or number query parameter is required' });
  }

  if (instanceId && number) {
    return res.status(400).send({ error: 'Only one of instanceId or number should be provided' });
  }

  try {
    let instance, agent, phoneNumber;

    if (instanceId) {
      // Get by instance ID
      instance = await Instance.findByPk(instanceId, { include: Agent });
      agent = instance?.Agent;
    } else if (number) {
      // Get by phone number
      phoneNumber = await PhoneNumber.findByPk(number, {
        include: [
          {
            model: Instance,
            include: [Agent]
          }
        ]
      });
      instance = phoneNumber?.Instance;
      agent = instance?.Agent;
    }
    
    if (!instance) {
      log.error({ instanceId, number }, 'instance not found');
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
  summary: 'Returns an instance by ID or phone number with its associated agent.',
  operationId: 'getInstance',
  tags: ["Agents"],
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
    {
      name: 'number',
      in: 'query',
      required: false,
      schema: {
        type: 'string'
      },
      description: 'The phone number to look up the instance for'
    }
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
