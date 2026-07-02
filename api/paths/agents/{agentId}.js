import { Agent, Instance, PhoneNumber } from '../../../lib/database.js';
import { scopeWhereForUser } from '../../../lib/scope.js';
import { validateAgentTargets, AgentSetValidationError } from '../../../lib/agent-set-labels.js';
import { isBuiltinAgentId, renderBuiltinAgent } from '../../../lib/builtin-agents.js';
import { isModelAllowed } from '../../../lib/auth/model-access.js';
import { requirePermission } from '../../../lib/auth/permissions.js';

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
  const { agentId } = req.params;
  return { id: agentId, ...scopeWhereForUser(res.locals.user) };
}

const agentGet = async (req, res) => {
  let { agentId } = req.params;
  if (isBuiltinAgentId(agentId)) {
    // R1/F7 — built-ins are gated by their `builtin:<id>` access prefix.
    if (!isModelAllowed(agentId, res.locals.user?._allowedModels)) {
      return res.status(404).send({ error: `Agent with ID ${agentId} not found` });
    }
    const builtin = renderBuiltinAgent(agentId, res.locals.user);
    return builtin
      ? res.send(builtin)
      : res.status(404).send({ error: `Agent with ID ${agentId} not found` });
  }
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
    // R1 — reading is restricted to models in the principal's effective allow-list.
    if (!isModelAllowed(agent.modelName, res.locals.user?._allowedModels)) {
      return res.status(403).send({ message: 'model_not_permitted', detail: `Model ${agent.modelName} is not permitted for your account.` });
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
              mcpServers: {
                $ref: '#/components/schemas/McpServers'
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
  let { name, description, prompt, options, functions, mcpServers, keys, modelName, type } = req.body;
  let { agentId } = req.params;

  if (isBuiltinAgentId(agentId)) {
    return res.status(403).send({ message: `Agent ${agentId} is a read-only built-in and cannot be modified` });
  }
  if (!requirePermission(res, 'agent', 'update')) return;
  // R1 — a modelName CHANGE must stay within the principal's allow-list, else a
  // restricted user could PUT an existing agent onto a disallowed model (escaping
  // the create-time gate).
  if (modelName !== undefined && !isModelAllowed(modelName, res.locals.user?._allowedModels)) {
    return res.status(403).json({ message: 'model_not_permitted', detail: `Model ${modelName} is not permitted for your account.` });
  }
  try {
    let agent = await Agent.findOne({ where: agentWhere(req, res) });
    if (!agent) {
      throw new Error(`Agent with ID ${agentId} not found`);
    }
    // Static transfer_agent/subagent targets and options.bridgedTransferToAgent
    // targets must reference accessible agents of the right type
    (functions || options?.bridgedTransferToAgent) && await validateAgentTargets(functions || [], {
      lookupAgent: (targetId) => Agent.findOne({ where: { id: targetId, ...scopeWhereForUser(res.locals.user) } }),
      options
    });
    await agent.update({ name, description, prompt, options, functions, mcpServers, keys, modelName, type });
    req.log.info({ ...agent.dataValues, keys: undefined }, 'Agent updated');
    res.send({ ...agent.dataValues, keys: undefined });
  }
  catch (err) {
    req.log.error(err);
    if (err instanceof AgentSetValidationError) {
      return res.status(400).send({ message: err.message });
    }
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
            type: {
              $ref: '#/components/schemas/AgentType',
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
            mcpServers: {
              $ref: '#/components/schemas/McpServers'
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
              },
              mcpServers: {
                $ref: '#/components/schemas/McpServers'
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
  if (isBuiltinAgentId(agentId)) {
    return res.status(403).send({ message: `Agent ${agentId} is a read-only built-in and cannot be deleted` });
  }
  if (!requirePermission(res, 'agent', 'delete')) return;
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

