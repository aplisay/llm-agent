const cors = require("cors");
const { Agent, Instance } = require('../../../../lib/database');
const handlers = require('../../../../lib/handlers');

let appParameters, log;

module.exports =
  function () {
    const join = (async (req, res) => {
      let { listenerId } = req.params;
      req.log.debug({ listenerId, body: req.body }, 'join called');
      let { options } = req.body || {};
      res.set('Access-Control-Allow-Origin', '*');

      try {
        let instance = await Instance.findByPk(listenerId, { include: Agent });
        let { Agent: agent } = instance;
        req.log.debug({ req: '', agent, instance }, 'join instance');
        if (instance.number) {
          req.log.info('Join called on telephony room!');
          throw new Error('bad listener');
        }
        let Handler = handlers.getHandler(agent.modelName);
        let handler = new Handler({ agent, instance, logger: req.log });
        let room = await handler.join();
        res.send(room);
      }
      catch (err) {
        req.log.error({message: err?.message, stack: err?.stack}, 'join error');
        res.status(404).send(`no agent ${listenerId}`);
      }

    });
    join.apiDoc = {
      summary: 'Gets join information for a realtime room connected to an agent.',
      operationId: 'join',
      tags: ["Room"],
      responses: {
        200: {
          description: 'Agent activated.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'Agent information',
                properties: {
                  livekit: {
                    description: "Returned if the agent instance is connected to a Livekit room",
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
                    description: "Returned if the agent is connected to an Ultravox room",
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
      description: `Gets room joining information for the room connected to an instance of an agent.`,
      summary: 'Get the WebRTC room to talk to an agent',
      parameters: [
        {
          description: "ID of the agent listener instance",
          in: 'path',
          name: 'listenerId',
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
              options: {
                type: "object",
                description: "Options for this conversation",
                properties: {
                  streamLog: {
                    type: "boolean",
                    description: "If true, then this is a debug room which will post a live debug transcript as messages in the livekit room and/or socket",
                  }
                },
                required: [],
              }
            },
            required: [],
          }
        }
      },
      POST: join,
      // We want to overide CORS allowed origins for this one endpoint. CORS is set at a global level
      //  by an express use() before we add the OpenAPI middleware, but we can override specific headers
      //  here to add the requestors origin and narrow the allowed methods.
      OPTIONS: async (req, res, next) => {
          res.set('Access-Control-Allow-Origin', req?.headers?.origin || '*');
          res.set('Access-Control-Allow-Methods', 'POST');
          next();
      }
   
    };

  };