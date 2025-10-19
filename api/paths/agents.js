import { Agent, Instance, PhoneNumber } from '../../lib/database.js';

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



const agentList = (async (req, res) => {
  let userId = res.locals.user.id;
  try {
    let agents = await Agent.findAll({
      where: { userId },
      include: [
        {
          model: Instance,
          as: 'listeners',
          include: [
            {
              model: PhoneNumber,
              as: 'number',
            },
          ]
        }
      ]
    });
    res.send(agents);
  }
  catch (err) {
    req.log.error(err, 'listing agents');
    res.status(500).send(err);
  }
});
agentList.apiDoc = {
  summary: 'Returns a list of all this user\'s agents.',
  operationId: 'listAgents',
  tags: ["Agent"],
  responses: {
    200: {
      description: 'List of agents.',
      content: {
        'application/json': {
          schema: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/Agent'
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




