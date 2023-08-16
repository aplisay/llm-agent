const Application = require('../../../../../../lib/application');


module.exports = function (logger) {
  const callInject = async (req, res) => {
    let { text } = req.body;
    let { agentId, callId } = req.params;
    let application = Application.recover(agentId);
    if (!application) {
      res.status(404).send(`no agent ${agentId}`);
    }
    else {
      call = callId && Object.values(application.agent.sessions)
        .find(call => call?.session?.call_sid === callId);
      if (!call) {
        res.status(404).send({ message: 'call not found' });
      }
      else {
        try {
          await call.inject(text);
          res.send({ id: callId });
        }
        catch (e) {
          console.log(e, 'error');
          logger.error({ message: e.message, e }, 'injecting text');
          res.status(500).send({ msg: e.message });
        }
      }

    }

  };
  callInject.apiDoc = {
    summary: 'Injects direct application generated speech into the audio',
    description: `Injects speech asynchronously into the conversation. After the speech is sent, resets the conversation
                  into gathering state so that the STT is listening for input from the user which will be sent to the agent.
                  Bad things may well happen if the injection occurs at the same as agent output, the first output will be
                  truncated and in effect overtalked by the second. Needs work to determine how to do this safely.`,
    operationId: 'callInject',
    tags: ["Calls"],
    parameters: [
      {
        description: "ID of the parent agent for the call",
        in: 'path',
        name: 'agentId',
        required: true,
        schema: {
          type: 'string'
        }
      },
      {
        description: "ID of the call",
        in: 'path',
        name: 'callId',
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
              text: {
                description: "text to inject",
                type: 'string'
              }
            },
            required: ['text'],
          }
        }
      }
    },
    responses: {
      200: {
        description: 'Call',
        content: {
          'application/json': {
            schema: {
              type: "object",
              properties: {
                id: {
                  description: "id of call",
                  type: 'string'
                }
              },
            }
          }
        }
      },
      404: {
        description: 'Agent or call not found',
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
    POST: callInject,
  };
};

