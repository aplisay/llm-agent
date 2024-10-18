const { Agent, Instance } = require('../../../../lib/database');
const Application = require('../../../../lib/application');

let appParameters, log;

module.exports =
  function (logger, voices, wsServer) {
    const activate = (async (req, res) => {
      let { agentId } = req.params;
      let { number, options } = req.body;
      try {
        let application = new Application({ wsServer, logger });
        await application.load(agentId);
        let activation = await application.activate({ number, options });
        res.send(activation);

      }
      catch (err) {
        req.log.error(err);
        res.status(404).send(`no agent ${agentId}`);
      }

    });
    activate.apiDoc = {
      summary: 'Activates an instance of an agent to listen for either calls or WebRTC rooms connections.',
      operationId: 'activate',
      tags: ["Agent"],
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
                    description: "The full URL of a socket which can be opened to get a stream of progress information",
                    type: "string",
                    example: "https://example.com/agent/progress/LLM-gpt35-32555d87-948e-48f2-a53d-fc5f261daa79"
                  },
                  livekit: {
                    description: "If the agent is connected to a livekit room, this is the URL of the livekit room access information",
                    type: "object",
                    properties: {
                      url: {
                        description: "The URL of the livekit room access information",
                        type: "string",
                        example: "https://example.com/livekit/join/LLM-gpt35-32555d87-948e-48f2-a53d-fc5f261daa79"
                      },
                      token: {
                        description: "The token used to join the livekit room",
                        type: "string",
                        example: "<KEY>"
                      }
                    }
                  },
                  ultravox: {
                    description: "Set to true if the agent is connected to a ultravox room",
                    type: "object",
                    properties: {
                      joinUrl: {
                        description: "The URL of the ultravox websocket which then supplies the room access information",
                        type: "string",
                        example: "https://example.com/livekit/join/LLM-gpt35-32555d87-948e-48f2-a53d-fc5f261daa79"
                      }
                    }
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
      description: `Activates an agent. For telephone agents, this will allocate a number to the agent and start a call to the agent.
      For Ultravox or Livekit realtime agents, this will start a listening agent based on that technology.`,
      summary: 'Activate an instance of this agent as a telephone or WebRTC listener',
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
                options: {
                  type: "object",
                  description: "Options for this activation instance",
                  properties: {
                    streamLog: {
                      type: "boolean",
                      description: "If true, then this is a debug instance which will post a live debug transcript as messages in a livekit room and/or socket",
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
      POST: activate
    };

  };