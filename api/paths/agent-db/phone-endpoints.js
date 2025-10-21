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
  let { handler, number, type, offset, pageSize } = req.query;
  
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

    // Offset pagination
    const startOffset = Math.max(0, parseInt(offset || '0', 10) || 0);
    const size = Math.min(200, Math.max(1, parseInt(pageSize || '50', 10) || 50));

    const rows = await PhoneNumber.findAll({ where: whereClause, limit: size, offset: startOffset });
    const nextOffset = rows.length === size ? startOffset + size : null;
    
    res.send({ items: rows, nextOffset });
  }
  catch (err) {
    log.error(err, 'error fetching phone endpoints');
    res.status(500).send({ error: 'Internal server error' });
  }
});

phoneEndpointsList.apiDoc = {
  summary: 'Returns a list of phone endpoints, optionally filtered by handler.',
  description: `Returns a paginated list of phone endpoints for the caller\'s organisation. 
                Phone endpoints are used to assign numbers that then route via listeners to agents.
                Both E.164 DDI number and phone SIPregistration endpoints are supported.
                DDI numbers are assigned to trunks which are then used to route calls to agents.
                SIP registration endpoints are used to register with a SIP provider and identified by a unique
                non phone number like ID (UUID).`,
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
    },
    {
      name: 'offset',
      in: 'query',
      required: false,
      schema: { type: 'integer', minimum: 0, default: 0 },
      description: 'Offset (0-based)'
    },
    {
      name: 'pageSize',
      in: 'query',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      description: 'Page size (max 200)'
    }
  ],
  responses: {
    200: {
      description: 'List of phone endpoints.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  oneOf: [
                    {
                      type: 'object',
                      description: 'E.164 DDI endpoint',
                      required: ['number', 'handler'],
                      properties: {
                        name: { type: 'string', description: 'User-defined descriptive name', nullable: true },
                        id: { type: 'string', description: 'Database ID' },
                        number: { type: 'string', description: 'The phone number' },
                        instanceId: { type: 'string', format: 'uuid' },
                        handler: { type: 'string', description: 'The handler type for this phone endpoint' },
                        createdAt: { type: 'string', format: 'date-time' },
                        updatedAt: { type: 'string', format: 'date-time' }
                      }
                    },
                {
                  type: 'object',
                  description: 'Phone registration endpoint',
                  required: ['id', 'handler'],
                  properties: {
                    name: { type: 'string', description: 'User-defined descriptive name', nullable: true },
                    id: { type: 'string', description: 'Registration ID' },
                    status: { type: 'string', description: 'High-level status of the endpoint', enum: ['active', 'failed', 'disabled'] },
                    state: { type: 'string', description: 'Registration state', enum: ['initial', 'registering', 'registered', 'failed'] },
                    handler: { type: 'string', description: 'The handler type for this phone endpoint' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' }
                  }
                }
                  ]
                }
              },
              nextOffset: { type: 'integer', nullable: true, description: 'Next offset to request, or null if no more results' }
            },
            required: ['items', 'nextOffset']
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
