import { PhoneNumber } from '../../../lib/database.js';
import { normalizeE164 } from '../../../lib/validation.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    GET: phoneEndpointsList
  };
};

const phoneEndpointsList = (async (req, res) => {
  let { handler, number, type } = req.query;
  
  try {
    let whereClause = {};
    if (handler) {
      whereClause.handler = handler;
    }
    if (number) {
      // Database stores E.164 without a leading '+'
      whereClause.number = String(number).replace(/^\+/, '');
    }

    if (type) {
      if (type === 'e164-ddi') {
        whereClause.number = whereClause.number || { };
      }
      else if (type === 'phone-registration') {
        return res.send([]);
      }
    }

    let phoneNumbers = await PhoneNumber.findAll({ where: whereClause });
    
    res.send(phoneNumbers);
  }
  catch (err) {
    log.error(err, 'error fetching phone endpoints');
    res.status(500).send({ error: 'Internal server error' });
  }
});

phoneEndpointsList.apiDoc = {
  summary: 'Returns a list of phone endpoints, optionally filtered by handler.',
  operationId: 'listPhoneEndpoints',
  tags: ["Phone Endpoints"],
  parameters: [
    {
      name: 'handler',
      in: 'query',
      required: false,
      schema: {
        type: 'string'
      },
      description: 'Filter phone endpoints by handler (e.g., livekit, jambonz)'
    },
    {
      name: 'type',
      in: 'query',
      required: false,
      schema: {
        type: 'string',
        enum: ['e164-ddi', 'phone-registration']
      },
      description: 'Filter phone endpoints by endpoint type'
    }
  ],
  responses: {
    200: {
      description: 'List of phone endpoints.',
      content: {
        'application/json': {
          schema: {
            type: 'array',
            items: {
              oneOf: [
                {
                  type: 'object',
                  description: 'E.164 DDI endpoint',
                  required: ['number', 'handler'],
                  properties: {
                    id: {
                      type: 'string',
                      description: 'Database ID'
                    },
                    number: {
                      type: 'string',
                      description: 'The phone number'
                    },
                    instanceId: {
                      type: 'string',
                      format: 'uuid'
                    },
                    handler: {
                      type: 'string',
                      description: 'The handler type for this phone endpoint'
                    },
                    createdAt: {
                      type: 'string',
                      format: 'date-time'
                    },
                    updatedAt: {
                      type: 'string',
                      format: 'date-time'
                    }
                  }
                },
                {
                  type: 'object',
                  description: 'Phone registration endpoint',
                  required: ['id', 'handler'],
                  properties: {
                    id: {
                      type: 'string',
                      description: 'Registration ID'
                    },
                    handler: {
                      type: 'string',
                      description: 'The handler type for this phone endpoint'
                    },
                    createdAt: {
                      type: 'string',
                      format: 'date-time'
                    },
                    updatedAt: {
                      type: 'string',
                      format: 'date-time'
                    }
                  }
                }
              ]
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
