const Model = require('../../lib/model');
const { Agent } = require('../../lib/database');

let appParameters, log;

module.exports = function (logger, voices, wsServer, makeService) {
  (appParameters = {
    logger,
    voices,
    wsServer,
    makeService
  });
  log = logger;
  return {
    POST: agentCreate
  };
};

const agentCreate = (async (req, res) => {
  let { modelName, prompt, options, functions, keys } = req.body;
  let agent = Agent.build({ modelName, prompt, options, functions, keys });

  log.info({ modelName, prompt, options, functions }, 'create API call');

  try {
    await agent.save();
    res.send({ ...agent.dataValues, keys: undefined });
  }
  catch (err) {
    console.error(err, 'creating agent');
    req.log.error(err, 'creating agent');
    res.status(500).send(err);

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



