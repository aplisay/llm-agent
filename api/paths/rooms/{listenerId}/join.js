import cors from 'cors';
import { Agent, Instance } from '../../../../lib/database.js';
import { AgentConcurrencyLimitExceededError } from '../../../../lib/concurrency/agent-concurrency-limits.js';
import handlers from '../../../../lib/handlers/index.js';

let appParameters, log;

export default function () {
    const join = (async (req, res) => {
      let { listenerId } = req.params;
      req.log.debug({ listenerId, body: req.body }, 'join called');
      let { options } = req.body || {};
      res.set('Access-Control-Allow-Origin', '*');

      // Mirror the error-handling fix in /listener/{listenerId}/join.js:
      // real 404 only for missing rows; everything else surfaces with its
      // original status / message instead of being swallowed as 404.
      let instance, agent, Handler, handler;
      try {
        instance = await Instance.findByPk(listenerId, { include: Agent });
        agent = instance?.Agent;
      } catch (err) {
        req.log.error({ err, listenerId }, 'join: lookup failed');
        return res.status(500).send({ error: err?.message || 'lookup failed' });
      }
      if (!instance || !agent) {
        return res.status(404).send({ error: `no listener ${listenerId}` });
      }
      req.log.debug({ agent, instance }, 'join instance');
      if (instance.number) {
        req.log.info('Join called on telephony room!');
        return res.status(400).send({ error: 'cannot join a telephony listener' });
      }

      try {
        Handler = (await handlers()).getHandler(agent.modelName);
        if (!Handler) {
          return res.status(400).send({ error: `no handler for ${agent.modelName}` });
        }
        handler = new Handler({ agent, instance, logger: req.log });
        req.log.debug({ handler }, 'handler');
        let room = await handler.join({ options });
        return res.send(room);
      }
      catch (err) {
        if (err instanceof AgentConcurrencyLimitExceededError) {
          return res.status(429).send({
            error: err.message,
            code: err.code,
            scope: err.scope,
            details: err.details,
          });
        }
        req.log.error({ message: err?.message, stack: err?.stack, listenerId, modelName: agent?.modelName }, 'join: handler.join() threw');
        return res.status(500).send({ error: err?.message || 'handler.join failed' });
      }

    });
    join.apiDoc = {
      summary: 'Gets join information for a realtime room connected to an agent.',
      operationId: 'join',
      deprecated: true,
      tags: ["Listeners"],
      description: `Gets room joining information for the room connected to an instance of an agent.`,
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
              properties: {
                options: {
                  type: "object",
                  description: "Options for this conversation",
                  properties: {
                    streamLog: {
                      type: "boolean",
                      description: "If true, then this is a debug room which will post a live debug transcript as messages in the livekit room and/or socket",
                    },
                    metadata: {
                      type: "object",
                      description: "Metadata to be associated with this call, copied over the top of any metadata set in the listener activation.",
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
              required: []
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
                  callId: {
                    description: `The provisional call ID that will be used for any conversation in this room. 
                                 An ID will be returned but may or may not exist in the database unless/until a client subsequently joins the WebRTC room.`,
                    type: "string",
                    example: "32555d87-948e-48f2-a53d-fc5f261daa79"
                  },
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
                  },
                  audioSocket: {
                    description: "Returned if the agent is connected to an audio WebSocket",
                    type: "object",
                    properties: {
                      url: {
                        description: "The URL of the audio WebSocket",
                        type: "string",
                        example: "wss://example.com/audio"
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