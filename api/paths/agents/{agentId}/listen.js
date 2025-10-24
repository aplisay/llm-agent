import { Agent, PhoneNumber } from '../../../../lib/database.js';
import handlers from '../../../../lib/handlers/index.js';

let appParameters, log;

export default function (wsServer) {
  const activate = (async (req, res) => {
    let { agentId } = req.params;
    let { number, options, websocket, id } = req.body;
    let agent, handler, activation;
    try {
      agent = await Agent.findByPk(agentId);
      if (!agent?.id) {
        throw new Error(`no agent`);
      }

      // If id is provided, look up the phone endpoint and use its number
      if (id) {
        const phoneEndpoint = await PhoneNumber.findByPk(id);
        if (!phoneEndpoint) {
          throw new Error(`Phone endpoint with id ${id} not found`);
        }
        number = phoneEndpoint.number;
      }

      let Handler = (await handlers()).getHandler(agent.modelName);
      handler = new Handler({ agent, wsServer, logger: req.log });
      activation = await handler.activate({ number, options, websocket });
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
        if (err.message.includes('In use:')) {
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
                  description: `The telephone number to request allocate to the agent in E.164 format, or \"*\" to request an ephemeral number.`,
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