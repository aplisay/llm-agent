import { Agent, Instance, PhoneNumber  } from '../../../lib/database.js';;

let log;

module.exports = function (logger) {
  log = logger;
  return {
    GET: agentGet,
    PUT: agentUpdate,
    DELETE: agentDelete,
  };
};


const agentGet = async (req, res) => {
  let userId = res.locals.user.id;
  let { agentId } = req.params;
  try {
    let agent = await Agent.findOne({
      where: {
        id: agentId,
        userId,
      },
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
    req.log.info({ ...agent.dataValues, keys: undefined }, 'Agent fetched');
    res.send({ ...agent.dataValues, keys: undefined });
  }
  catch (err) {
    req.log.error(err);
    res.status(404).send(err);
  }
};

agentGet.apiDoc = {
  summary: 'Returns an existing agent',
  operationId: 'getAgent',
  tags: ["Agent"],
  parameters: [
    {
      description: "ID of the agent to fetch",
      in: 'path',
      name: 'agentId',
      required: true,
      schema: {
        type: 'string'
      }
    }
  ],
  responses: {
    200: {
      description: `Agent Definition.Note that \`keys\` are never returned, even if set. 
                    For security reasons these are write only.
                    Also returns an array of listeners that are active for this agent`,

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
              listeners: {
                type: 'array',
                items: {
                  properties:
                  {
                    id: {
                      description: "Listener unique ID",
                      type: "string",
                      format: "uuid",
                      example: "32555d87-948e-48f2-a53d-fc5f261daa79"
                    },
                    number: {
                      description: "The telephone number allocated to the agent in E.164 format (if any)",
                      type: "string",
                      example: "+442080996945"
                    }
                  }
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

const agentUpdate = async (req, res) => {
  let { prompt, options, functions, keys } = req.body;
  let { agentId } = req.params;

  try {
    let agent = await Agent.findOne({ where: { id: agentId } });
    if (!agent) {
      throw new Error(`Agent with ID ${agentId} not found`);
    }
    await agent.update({ prompt, options, functions, keys });
    req.log.info({ ...agent.dataValues, keys: undefined }, 'Agent updated');
    res.send({ ...agent.dataValues, keys: undefined });
  }
  catch (err) {
    req.log.error(err);
    err.message.includes('not found') ? res.status(404).send(err) : res.status(400).send(err);
  }
};
agentUpdate.apiDoc = {
  summary: 'Updates an existing agent',
  description: `All fields on an agent, except for the \`id\` and \`modelName\` may be mutated using this method.
                To change the \`modelName\`, create a new Agent instance.`,
  operationId: 'updateAgent',
  tags: ["Agent"],
  parameters: [
    {
      description: "ID of the agent to modify",
      in: 'path',
      name: 'agentId',
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
            },
            functions: {
              $ref: '#/components/schemas/Functions'
            },
            keys: {
              $ref: '#/components/schemas/Keys'
            }
          },
          required: [],
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Updated Agent. Note that `keys` are never returned for security reasons.',
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
              },
              functions: {
                $ref: '#/components/schemas/Functions'
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
  let { agentId } = req.params;
  let userId = res.locals.user.id;
  req.log.info({ id: agentId }, 'Agent delete called');
  try {
    let data = await Agent.destroy({
      where: {
        id: agentId,
        userId
      },
    });
    if (data === 0)
      throw new Error(`Agent with ID ${agentId} not found`);
    res.status(200).send();
  }
  catch (err) {
    res.status(404).send(err);
    req.log.error(err, 'deleting instance');
  }

};
agentDelete.apiDoc = {
  summary: 'Deletes an agent',
  operationId: 'deleteAgent',
  tags: ["Agent"],
  parameters: [
    {
      description: "ID of the agent to delete",
      in: 'path',
      name: 'agentId',
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

