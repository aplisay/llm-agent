import { Agent, PhoneNumber, PhoneRegistration } from '../../../../lib/database.js';
import { scopeWhereForUser } from '../../../../lib/scope.js';
import handlers from '../../../../lib/handlers/index.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';

let appParameters, log;

export default function (wsServer) {
  const activate = (async (req, res) => {
    if (!requirePermission(res, 'agent', 'deploy')) return;
    let { agentId } = req.params;
    let { number, options = {}, websocket, id } = req.body;
    let agent, handler, activation;
    try {
      agent = await Agent.findOne({
        where: { id: agentId, ...scopeWhereForUser(res.locals.user) }
      });
      if (!agent?.id) {
        throw new Error(`no agent`);
      }

      // If id is provided, look up the PhoneRegistration record
      if (id) {
        const phoneRegistration = await PhoneRegistration.findByPk(id);
        if (!phoneRegistration) {
          throw new Error(`Phone endpoint with id ${id} not found`);
        }
        // For registration endpoints, we pass the id to the handler
        // The handler should know how to work with registration endpoints
      }
      
      // If number is provided, look up the PhoneNumber record
      if (number) {
        const phoneNumber = await PhoneNumber.findByPk(number);
        if (!phoneNumber) {
          throw new Error(`Phone number ${number} not found`);
        }
        // Use the number as provided
      }

      let Handler = (await handlers()).getHandler(agent.modelName);
      handler = new Handler({ agent, wsServer, logger: req.log });
      
      // Prepare activation parameters
      const activationParams = { options, websocket };
      if (number) {
        activationParams.number = number;
      }
      if (id) {
        activationParams.id = id;
      }
      
      activation = await handler.activate(activationParams);
      res.send(activation);
    }
    catch (err) {
      req.log.error(err);
      if (!agent?.id) {
        res.status(404).send(`no agent ${agentId}`);
      }
      else if (!handler) {
        res.status(400).send(`no handler for ${agent.modelName} ${err.message}`);
      }
      else {
        let status = 404;
        if (typeof err.status === 'number') {
          // Validation failures (e.g. listener transfer overrides) carry
          //  their own HTTP status
          status = err.status;
        }
        else if (err.message.includes('In use:')) {
          status = 409;
        }
        else if (err.message.includes('Not supported:')) {
          status = 412;
        }
        res.status(status).send(err.message);
      }
    }
  });

  activate.apiDoc = {
    description: `Activates an agent. For telephone agents, this will allocate a number to the agent and wait for calls to the agent.
    For Ultravox or Livekit realtime agents, this will start a listening agent based on that technology.
    For websocket agents (currently only available for the Ultravox technology), this will start a listening agent that will await connects
    from a websocket client. For WebRTC agents, omit number, id, and websocket parameters to activate a WebRTC room-based agent.`,
    summary: 'Activates an instance of an agent to listen for either calls, WebRTC rooms, or websocket connections.',
    operationId: 'activate',
    tags: ["Listeners"],
    parameters: [
      {
        description: "ID of the parent agent",
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
                number: {
                  type: "string",
                  description: `The telephone number to allocate to the agent, in E.164 format. Must be a number your organisation owns.`,
                  example: "+442080996945"
                },
                id: {
                  type: "string",
                  description: "ID of a phone endpoint to use instead of specifying number directly.",
                  example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
                },
                websocket: {
                  type: "boolean",
                  description: "If true, then this is a websocket session",
                  example: true
                },
                options: {
                  type: "object",
                  description: "Options for this activation instance",
                  properties: {
                    agentLimit: {
                      type: "integer",
                      nullable: true,
                      description: `Optional agent concurrency cap for the created listener instance (see \`docs/agent-concurrency-limits.md\` for semantics). For example: 0 disallows new concurrent calls; null means unlimited.`,
                      example: 1
                    },
                    streamLog: {
                      type: "boolean",
                      description: "If true, then this is a debug instance which will post a live debug transcript as messages in a livekit room and/or socket",
                    },
                    metadata: {
                      type: "object",
                      description: "Metadata to be associated with this activation instance, can be overriden by the agent join for finer, per user control",
                      example: {
                        myapp: {
                          mykey: "mydata"
                        }
                      }
                    },
                    bridgedTransferToAgent: {
                      type: "object",
                      additionalProperties: true,
                      description: `Per-listener override of the agent's \`options.bridgedTransferToAgent\` hand-back map
                        (see \`docs/call-transfers.md\`). When present it wholesale-replaces the agent-level map for
                        every call on this listener. Keys are DTMF sequences (1-8 chars of 0-9, * and #); values are an
                        agent UUID or \`{ agent, includeHistory }\`. \`label:\` references are allowed when the agent is
                        a member of an agent set and are resolved at activation time.`,
                      example: { "1": "label:followup" }
                    },
                    bridgedTransferTranscribe: {
                      description: `Per-listener override of the agent's \`options.bridgedTransferTranscribe\` (bridged-segment
                        transcription). Boolean, or \`{ enabled, provider, language }\`. Wholesale-replaces the agent-level
                        value for every call on this listener.`,
                      oneOf: [
                        { type: "boolean" },
                        { type: "object", additionalProperties: true }
                      ],
                      example: true
                    },
                    dtmfTimeout: {
                      type: "integer",
                      minimum: 100,
                      maximum: 60000,
                      description: `Per-listener override of the agent's \`options.dtmfTimeout\` inter-digit timeout in
                        milliseconds (DTMF input buffering and hand-back sequence matching).`,
                      example: 1500
                    }
                  },
                  required: [],
                }
              },
              anyOf: [
                { required: ["number"] },
                { required: ["id"] },
                { required: ["websocket"] },
                { 
                  properties: {
                    options: {
                      type: "object",
                      description: "Options for this activation instance",
                      properties: {
                        agentLimit: {
                          type: "integer",
                          nullable: true,
                          description: `Optional agent concurrency cap for the created listener instance (see \`docs/agent-concurrency-limits.md\` for semantics). For example: 0 disallows new concurrent calls; null means unlimited.`,
                          example: 1
                        },
                        streamLog: {
                          type: "boolean",
                          description: "If true, then this is a debug instance which will post a live debug transcript as messages in a livekit room and/or socket",
                        },
                        metadata: {
                          type: "object",
                          description: "Metadata to be associated with this activation instance, can be overriden by the agent join for finer, per user control",
                          example: {
                            myapp: {
                              mykey: "mydata"
                            }
                          }
                        },
                        bridgedTransferToAgent: {
                          type: "object",
                          additionalProperties: true,
                          description: `Per-listener override of the agent's \`options.bridgedTransferToAgent\` hand-back map
                            (see \`docs/call-transfers.md\`). When present it wholesale-replaces the agent-level map for
                            every call on this listener. Keys are DTMF sequences (1-8 chars of 0-9, * and #); values are an
                            agent UUID or \`{ agent, includeHistory }\`. \`label:\` references are allowed when the agent is
                            a member of an agent set and are resolved at activation time.`,
                          example: { "1": "label:followup" }
                        },
                        bridgedTransferTranscribe: {
                          description: `Per-listener override of the agent's \`options.bridgedTransferTranscribe\` (bridged-segment
                            transcription). Boolean, or \`{ enabled, provider, language }\`. Wholesale-replaces the agent-level
                            value for every call on this listener.`,
                          oneOf: [
                            { type: "boolean" },
                            { type: "object", additionalProperties: true }
                          ],
                          example: true
                        },
                        dtmfTimeout: {
                          type: "integer",
                          minimum: 100,
                          maximum: 60000,
                          description: `Per-listener override of the agent's \`options.dtmfTimeout\` inter-digit timeout in
                            milliseconds (DTMF input buffering and hand-back sequence matching).`,
                          example: 1500
                        }
                      },
                      required: [],
                    }
                  },
                  required: []
                }
              ]
            }
        }
      }
    },
    responses: {
      200: {
        description: 'Agent activated.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              description: 'Agent information',
              properties: {
                id: {
                  description: "An activation ID",
                  type: "string",
                  format: "uuid",
                  example: "32555d87-948e-48f2-a53d-fc5f261daa79"
                },
                number: {
                  description: "The telephone number allocated to the agent in E.164 format",
                  type: "string",
                  example: "+442080996945"
                },
                socket: {
                  description: `The full URL of a socket which can be opened to get a stream of progress information
                                only returned when available and when the streamLog option is true`,
                  type: "string",
                  example: "https://example.com/agent/progress/LLM-gpt35-32555d87-948e-48f2-a53d-fc5f261daa79"
                },
                audioSocket: {
                  description: "The full URL of a socket which can be opened to exchange audio with the agent",
                  type: "string",
                  example: "https://example.com/agent/audio/Ultravox-96255d87-948e-48f2-157d-fc5f261d2345"
                }
              }
            }
          }
        }
      },
      404: {
        description: 'Agent not found or requested number not available',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/NotFound'
            }
          }
        }
      },
      409: {
        description: 'Requested number is already in use by another agent',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/Conflict'
            }
          }
        }
      },
      412: {
        description: 'Requested number exists but is not supported by this agent',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/PreConditionFailed'
            }
          }
        }
      },
      default: {
        description: 'Another kind of error occurred',
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

  return {
    POST: activate
  };
};