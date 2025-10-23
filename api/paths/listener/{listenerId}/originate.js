import { Agent, Instance, PhoneNumber } from '../../../../lib/database.js';
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

    // Check if callerId is present in phoneNumbers table and belongs to the organisation
    let callerPhoneNumber = await PhoneNumber.findByPk(callerId);
    if (!callerPhoneNumber || callerPhoneNumber.organisationId !== organisationId) {
      return res.status(404).send({
        error: `Caller phone number ${callerId} not found in phone numbers table`
      });
    }

    if (!callerPhoneNumber.outbound) {
      return res.status(400).send({
        error: `Caller phone number ${callerId} is not enabled for outbound calling`
      });
    }

    // Validate that calledId is a valid UK geographic or mobile number
    if (!calledId.match(/^(\+44|44|0)[1237]\d{6,15}$/)) {
      return res.status(400).send({
        error: `Called number ${calledId} is not a valid UK geographic or mobile number`
      });
    }
    const aplisayId = callerPhoneNumber.aplisayId;
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
              description: "The phone number to call from (must exist in phoneNumbers table and belong to the organisation)",
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
