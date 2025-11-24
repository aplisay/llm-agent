import { Agent, Instance, PhoneNumber, PhoneRegistration } from '../../../../lib/database.js';
import { getHandler } from '../../../../lib/handlers/index.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    POST: originateCall
  };
};



const originateCall = (async (req, res) => {
  let { listenerId } = req.params;
  let { calledId, callerId, metadata } = req.body;
  let { organisationId } = res.locals.user;

  try {
    // Validate required parameters - this is belt and braces and JSON schema should catch this
    if (!calledId || !callerId) {
      return res.status(400).send({
        error: 'Missing required parameters: calledId and callerId are required'
      });
    }

    // Check if agent exists and belongs to the organisation
    const instance = await Instance.findByPk(listenerId, { include: [{ model: Agent }] });
    const agent = instance?.Agent;

    if (!instance?.id || instance.organisationId !== organisationId) {
      return res.status(404).send({ error: `Agent ${listenerId} not found` });
    }

    // Check if callerId is present in phoneNumbers table or phoneRegistrations table and belongs to the organisation
    let callerPhoneNumber = await PhoneNumber.findByPk(callerId);
    let callerPhoneRegistration = null;
    let aplisayId = null;
    
    if (callerPhoneNumber && callerPhoneNumber.organisationId === organisationId) {
      // Found in phone numbers table
      if (!callerPhoneNumber.outbound) {
        return res.status(400).send({
          error: `Caller phone number ${callerId} is not enabled for outbound calling`
        });
      }
      aplisayId = callerPhoneNumber.aplisayId;
    } else {
      // Try phone registrations table
      callerPhoneRegistration = await PhoneRegistration.findByPk(callerId);
      if (!callerPhoneRegistration || callerPhoneRegistration.organisationId !== organisationId) {
        return res.status(404).send({
          error: `Caller ${callerId} not found in phone numbers or registrations table`
        });
      }
      // For registrations, we don't check outbound flag as they're typically for inbound
      // but we can still use them for outbound calls
    }

    // Validate that calledId matches the agent's outboundCallFilter if specified
    if (agent.options?.outboundCallFilter) {
      const filterRegexp = new RegExp(agent.options.outboundCallFilter);
      if (!filterRegexp.test(calledId)) {
        return res.status(400).send({
          error: `Called number ${calledId} does not match the agent's outbound call filter pattern`
        });
      }
    } else {
      // Fallback to default UK validation if no filter is specified
      if (!calledId.match(/^(\+44|44|0)[1237]\d{6,15}$/)) {
        return res.status(400).send({
          error: `Called number ${calledId} is not a valid UK geographic or mobile number`
        });
      }
    }

    // Check if the handler for this model has a outbound handler
    let handler = await getHandler(agent.modelName);
    if (!handler?.outbound) {
      return res.status(400).send({
        error: `Agent ${agent.modelName} cannot make outbound calls`
      });
    }

    const { callId } = await handler.outbound({ instance, callerId, calledId, metadata, aplisayId });

    // If all validations pass, return success
    res.send({
      success: true,
      message: 'Call origination request validated successfully',
      data: {
        callId,
        listenerId,
        callerId,
        calledId,
        organisationId
      }
    });

  } catch (err) {
    req.log.error(err, 'Error in originate call endpoint');
    res.status(500).send({ error: 'Internal server error' });
  }
});

originateCall.apiDoc = {
  summary: 'Originate a call from an agent instance using a caller number to a called number.',
  operationId: 'originateCall',
  tags: ["Listeners"],
  parameters: [
    {
      description: "ID of the instance to originate the call from",
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
            calledId: {
              type: "string",
              description: "The phone number to call (must be a valid UK geographic or mobile number)",
              example: "+447911123456"
            },
            callerId: {
              type: "string",
              description: "The phone number or registration ID to call from (must exist in phoneNumbers or phoneRegistrations table and belong to the organisation)",
              example: "+442080996945"
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
          required: ['calledId', 'callerId']
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Call origination request validated successfully.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              success: {
                type: 'boolean',
                example: true
              },
              message: {
                type: 'string',
                example: 'Call origination request validated successfully'
              },
              data: {
                type: 'object',
                properties: {
                  callId: {
                    type: 'string'
                  },
                  agentId: {
                    type: 'string'
                  },
                  callerId: {
                    type: 'string'
                  },
                  calledId: {
                    type: 'string'
                  },
                  organisationId: {
                    type: 'string'
                  }
                }
              }
            }
          }
        }
      }
    },
    400: {
      description: 'Bad request - missing parameters or invalid UK phone number',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    403: {
      description: 'Forbidden - access denied',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    404: {
      description: 'Not found - agent or caller phone number not found',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    }
  }
};
