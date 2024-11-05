


module.exports = function (logger) {
  
  const callHangup = async (req, res) => {
    let { agentId, callId } = req.params;
    logger.debug({ agentId, callId }, 'callHangup');
    let application = Application.recover(agentId);
    if (!application) {
      res.status(404).send(`no agent ${agentId}`);
    }
    else {
      let call = callId && Object.values(application.agent.sessions)
        .find(call => call?.session?.call_sid === callId);
      logger.debug({ call }, 'updating call');
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
    DELETE: callHangup,
  };
};

