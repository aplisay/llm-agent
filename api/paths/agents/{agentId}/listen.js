const { Agent } = require('../../../../lib/database');
const handlers = require('../../../../lib/handlers');

let appParameters, log;

module.exports =
  function (wsServer) {
    const activate = (async (req, res) => {
      let { agentId } = req.params;
      let { number, options } = req.body;
      let agent, handler, activation;
      try {
        agent = await Agent.findByPk(agentId);
        let Handler = handlers.getHandler(agent.modelName);
        handler = new Handler({ agent, wsServer, logger: req.log });
        activation = await handler.activate({ number, options });
        res.send(activation);
      }
      catch (err) {
        req.log.error(err);
        if (!agent) {
          res.status(404).send(`no agent ${agentId}`);
        }
        else if (!handler) {
          res.status(400).send(`no handler for ${agent.modelName}`);
        }
        else {
          res.status(404).send(err.message);
        }
      }

    });
    activate.apiDoc = {
      description: `Activates an agent. For telephone agents, this will allocate a number to the agent and start a call to the agent.
      For Ultravox or Livekit realtime agents, this will start a listening agent based on that technology.
      For websocket agents (currently only available for the Ultravox technology), this will start a listening agent that will await connects
      from a websocket client.`,
      summary: 'Activates an instance of an agent to listen for either calls, WebRTC rooms, or websocket connections.',
      operationId: 'activate',
      tags: ["Agent"],
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
                  description: `The telephone number to request allocate to the agent in E.164 format, or \"*\" to request an ephemeral number.
                                If this field is not present then the session will be assumed to be a WebRTC session.`,
                  example: "+442080996945"
                },
                websocket: {
                  type: "boolean",
                  description: "If true, then this is a websocket session, mutually exclusive with number",
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
                        myapp:
                        {
                          mykey: "mydata"
                        }
                      }
                  
                    }
                  },
                  required: [],
                }
              },
              required: [],
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
          description: 'Agent not found',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/NotFound'
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