const Application = require('../../lib/application');

let appParameters, log;

module.exports = function (logger, wsServer, makeService) {
  (appParameters = {
    logger,
    wsServer,
    makeService
  });
  log = logger;
  Application.cleanAll();
  return {
    POST: agentCreate
  };
};

const agentCreate = (async (req, res) => {
  let { modelName, prompt, options } = req.body;
  log.info({ modelName, body: req.body }, 'create');

  if (!Application.agents[modelName]) {
    res.status(405).send(`no agent for ${modelName}`);
  }
  else {

    try {
      let application = new Application({ ...appParameters, modelName, prompt, options });
      let number = await application.create();
      log.info({ application, appParameters }, `Application created on Nnumber ${number} with id ${application.id}`);
      if (number) {
        res.send({ number, id: application.id, socket: application.agent.socketPath });
      }
      else {
        res.status(424).send({ message: "No free phone numbers available on instance, please try later" });
      }
    }
    catch (err) {
      res.status(500).send(err);
      req.log.error(err, 'creating agent');
    }


  }

});
agentCreate.apiDoc = {
  summary: 'Creates an agent and associates it with a phone number',
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
            }
          },
          required: ['modelName', 'prompt']
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



