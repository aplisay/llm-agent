const Application = require('../../lib/application');

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
  let { modelName, prompt, options, callbackUrl, functions } = req.body;
  log.info({ modelName, prompt, options, functions }, 'create API call');
  let application;

  try {
    application = new Application({ ...appParameters, modelName, prompt, options, functions, callbackUrl });
    if (!application) {
      throw new Error(`No application for ${modelName} Application not created`);
    }
  }
  catch (e) {
    res.status(405).send({ message: e.message });
  }
  try {
    let { number, id, socket } = await application.create();
    log.info({ application, appParameters }, `Application created on Number ${number} with id ${application.id}`);
    if (number || application.agent.constructor.audioModel) {
      res.send({ number, id, socket });
    }
    else {
      res.status(424).send({
        message: application.jambonz ?
          "No free phone numbers available on instance, please try later" :
          "Couldn't create inband call"
      });
    }
  }
  catch (err) {
    console.error(err, 'creating agent');
    req.log.error(err, 'creating agent');
    res.status(500).send(err);

  }
});
agentCreate.apiDoc = {
  summary: 'Creates an agent and possibly associates it with a phone number',
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
            callbackUrl: {
              $ref: '#/components/schemas/CallbackUrl'
            },
            functions: {
              $ref: '#/components/schemas/Functions'
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
              id: {
                description: "Agent unique ID",
                type: "string",
                format: "uuid",
                example: "LLM-gpt35-32555d87-948e-48f2-a53d-fc5f261daa79"
              },
              number: {
                description: "The telephone number allocated to the agent in E.164 format",
                type: "string",
                example: "+442080996945"
              },
              socket: {
                description: "The full URL of a socket which can be opened to get a stream of progress information",
                type: "string",
                example: "https://example.com/agent/progress/LLM-gpt35-32555d87-948e-48f2-a53d-fc5f261daa79"
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



