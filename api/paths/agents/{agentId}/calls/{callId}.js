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
    description: `Call this endpoint to dynamically change the agent prompt/options for just this call.
                  Takes effect asynchronously at the next speech detection event in call after the update
                  completes`,
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
    description: `Causes the agent to gracefully end the call by telling the caller they
                  have to go now, then hanging up the telephone call at the recipient end.
                  The API call returns once this process has started. The actual hangup is
                  irrevocable and asynchronous and will happen at some point after the API call
                  is made but may not be complete by the time the return value is sent.`,
    operationId: 'callHangup',
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
    tags: ["Calls"],
    responses: {
      200: {
        description: 'Request accepted, hanging up the call',
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
    PUT: callUpdate,
    DELETE: callHangup,
  };
};

