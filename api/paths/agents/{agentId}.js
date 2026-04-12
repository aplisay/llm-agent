import { Agent, Instance, PhoneNumber, Op } from '../../../lib/database.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: agentGet,
    PUT: agentUpdate,
    DELETE: agentDelete,
  };
};


function agentWhere(req, res) {
  const { id: userId, organisationId } = res.locals.user;
  const { agentId } = req.params;
  return organisationId
    ? { id: agentId, [Op.or]: [{ userId }, { organisationId }] }
    : { id: agentId, userId };
}

const agentGet = async (req, res) => {
  let { agentId } = req.params;
  try {
    let agent = await Agent.findOne({
      where: agentWhere(req, res),
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
    if (!agent) {
      return res.status(404).send({ error: `Agent with ID ${agentId} not found` });
    }
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
  let { name, description, prompt, options, functions, keys, modelName } = req.body;
  let { agentId } = req.params;

  try {
    let agent = await Agent.findOne({ where: agentWhere(req, res) });
    if (!agent) {
      throw new Error(`Agent with ID ${agentId} not found`);
    }
    await agent.update({ name, description, prompt, options, functions, keys, modelName });
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
  description: `All fields on an agent, except for the \`id\` may be mutated using this method.`,
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
            name: {
              description: 'Display name for the agent',
              type: 'string',
            },
            description: {
              description: 'Description of the agent',
              type: 'string',
            },
            modelName: {
              $ref: '#/components/schemas/ModelName',
            },
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
              name: {
                description: 'Display name for the agent',
                type: 'string',
              },
              description: {
                description: 'Description of the agent',
                type: 'string',
              },
              modelName: {
                $ref: '#/components/schemas/ModelName'
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
  req.log.info({ id: agentId }, 'Agent delete called');
  try {
    let data = await Agent.destroy({
      where: agentWhere(req, res),
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

