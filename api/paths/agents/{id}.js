const Application = require('../../../lib/application');

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
    PUT: agentUpdate,
    DELETE: agentDelete,
  };
};


const agentUpdate = async (req, res) => {
  let { prompt, options } = req.body;
  let { id } = req.params;
  console.log({ id, prompt, options }, 'update');
  let application = Application.recover(id);
  if (!application) {
    res.status(404).send(`no agent ${id}`);
  }
  else {
    prompt && (application.prompt = prompt);
    options && (application.options = { ...application.options, ...options });
    res.send({ prompt: application.prompt, options: application.options, id: application.id });
  }
};
agentUpdate.apiDoc = {
  summary: 'Updates an existing, operating agent',
  operationId: 'updateAgent',
  parameters: [
    {
      description: "ID of the agent to modify",
      in: 'path',
      name: 'id',
      required: true,
      schema: {
        type: 'string'
      }
    }
  ],
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: "object",
          properties: {
            prompt: {
              $ref: '#/components/schemas/Prompt',
            },
            options: {
              $ref: '#/components/schemas/AgentOptions',
            }
          },
          required: [],
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
                example: "32555d87-948e-48f2-a53d-fc5f261daa79"
              },
              options: {
                $ref: '#/components/schemas/AgentOptions'
              },
              prompt: {
                $ref: '#/components/schemas/Prompt'
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

const agentDelete = async (req, res) => {
  let { id } = req.params;
  log.info({ id }, 'delete');
  let application;

  if (!(application = Application.recover(id))) {
    res.status(404).send(`no agent for ${id}`);
  }
  else {

    try {
      await application.destroy();
      res.send({ id });
    }
    catch (err) {
      res.status(500).send(err);
      req.log.error(err, 'deleting agent');
    }


  }

};
agentDelete.apiDoc = {
  summary: 'Deletes an agent',
  operationId: 'deleteAgent',
  parameters: [
    {
      description: "ID of the agent to delete",
      in: 'path',
      name: 'id',
      required: true,
      schema: {
        type: 'string'
      }
    }
  ],
  responses: {
    200: {
      description: 'Deleted Agent.',
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

