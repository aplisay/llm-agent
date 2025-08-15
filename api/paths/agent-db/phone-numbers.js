import { PhoneNumber } from '../../../lib/database.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    GET: phoneNumbersList
  };
};

const phoneNumbersList = (async (req, res) => {
  let { handler } = req.query;
  
  try {
    let whereClause = {};
    if (handler) {
      whereClause.handler = handler;
    }

    let phoneNumbers = await PhoneNumber.findAll({ where: whereClause });
    
    res.send(phoneNumbers);
  }
  catch (err) {
    log.error(err, 'error fetching phone numbers');
    res.status(500).send({ error: 'Internal server error' });
  }
});

phoneNumbersList.apiDoc = {
  summary: 'Returns a list of phone numbers, optionally filtered by handler.',
  operationId: 'listPhoneNumbers',
  tags: ["Phone Numbers"],
  parameters: [
    {
      name: 'handler',
      in: 'query',
      required: false,
      schema: {
        type: 'string'
      },
      description: 'Filter phone numbers by handler (e.g., livekit, jambonz)'
    }
  ],
  responses: {
    200: {
      description: 'List of phone numbers.',
      content: {
        'application/json': {
          schema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string'
                },
                number: {
                  type: 'string'
                },
                instanceId: {
                  type: 'string',
                  format: 'uuid'
                },
                handler: {
                  type: 'string'
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
