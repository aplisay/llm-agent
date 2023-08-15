const Application = require('../../../../../lib/application');


module.exports = function (logger) {
  const callUpdate = async (req, res) => {
    let { prompt, options } = req.body;
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
          call.prompt = prompt;
          call.options = options;
          res.send({ id: callId });
        }
        catch (e) {
          console.log(e, 'error');
          logger.error({ message: e.message, e }, 'updating call agent error');
          res.status(500).send({ msg: e.message });
        }
      }

    }

  };
  callUpdate.apiDoc = {
    summary: 'Updates the agent being used on a call',
    operationId: 'callUpdate',
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
              prompt: {
                $ref: '#/components/schemas/Prompt',
              },
              options: {
                $ref: '#/components/schemas/AgentOptions',
              }
            },
            required: [],
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
              $ref: '#/components/schemas/Call'
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

  const callHangup = async (req, res) => {
    let { agentId, callId } = req.params;
    logger.info({ agentId, callId }, 'callHangup');
    let application = Application.recover(agentId);
    if (!application) {
      res.status(404).send(`no agent ${agentId}`);
    }
    else {
      let call = callId && Object.values(application.agent.sessions)
        .find(call => call?.session?.call_sid === callId);
      logger.info({ call }, 'updating call');
      if (call) {
        await call.forceClose();
        res.send({ id: callId });
      }
      else {
        res.status(404).send({ message: 'call not found' });
        
      }
    }

  };
  callHangup.apiDoc = {
    summary: 'Hangs up a call',
    operationId: 'callHangup',
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
    responses: {
      200: {
        description: 'Hanging up call: may not be synchronous, call may still be in progress and closing',
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

  return {
    PUT: callUpdate,
    DELETE: callHangup,
  };
};

