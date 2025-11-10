import { PhoneNumber, PhoneRegistration, Trunk, Sequelize, Op } from '../../../lib/database.js';
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
  let { handler, number, id, type, offset, pageSize, trunkId } = req.query;

  try {
    // Infer type from id or number if type is not specified
    if (!type) {
      if (id) {
        type = 'phone-registration';
      } else if (number) {
        type = 'e164-ddi';
      }
    }

    // Validate parameter combinations based on type
    if (type === 'e164-ddi') {
      // ('e164-ddi', defined, defined): error - can't specify id for type ddi
      if (id) {
        return res.status(400).send({ error: "Cannot specify 'id' parameter for type 'e164-ddi'" });
      }

      if (number) {
        // ('e164-ddi', undefined, defined): return a single number matching the phone number (filtered by handler if defined)
        const normalizedNumber = String(number).replace(/^\+/, '');
        // Use a single query with LEFT JOIN to fetch phone number and trunk in one call
        const phoneNumber = await PhoneNumber.findOne({
          where: { number: normalizedNumber },
          include: [{
            model: Trunk,
            as: 'Trunk',
            required: false,
            attributes: ['id', 'outbound', 'flags']
          }]
        });
        if (!phoneNumber) {
          return res.status(404).send({ error: 'Phone endpoint not found' });
        }
        // Apply handler filter if provided
        if (handler && phoneNumber.handler !== handler) {
          return res.send({ items: [], nextOffset: null });
        }

        // Validate trunkId if provided (for inbound call validation)
        if (trunkId && phoneNumber.aplisayId !== null && phoneNumber.aplisayId !== trunkId) {
          return res.status(400).send({
            error: `Trunk mismatch: call arrived on trunk ${trunkId} but number is assigned to trunk ${phoneNumber.aplisayId || 'none'}`
          });
        }


        // Build response object with trunk info if available
        const phoneNumberJson = phoneNumber.toJSON();
        if (phoneNumber.Trunk) {
          phoneNumberJson.trunk = {
            id: phoneNumber.Trunk.id,
            outbound: phoneNumber.Trunk.outbound,
            flags: phoneNumber.Trunk.flags
          };
          // Remove the Sequelize include key (toJSON includes associated models)
          delete phoneNumberJson.Trunk;
        }

        return res.send({
          items: [phoneNumberJson],
          nextOffset: null
        });
      } else {
        // ('e164-ddi', undefined, undefined): list all numbers (filtered by handler if defined)
        const whereClause = {};
        if (handler) {
          whereClause.handler = handler;
        }

        const startOffset = Math.max(0, parseInt(offset || '0', 10) || 0);
        const size = Math.min(200, Math.max(1, parseInt(pageSize || '50', 10) || 50));

        const rows = await PhoneNumber.findAll({ where: whereClause, limit: size, offset: startOffset });
        const nextOffset = rows.length === size ? startOffset + size : null;

        return res.send({ items: rows, nextOffset });
      }
    }

    if (type === 'phone-registration') {
      // ('phone-registration', undefined, defined): error - can't specify number for registration
      if (number) {
        return res.status(400).send({ error: "Cannot specify 'number' parameter for type 'phone-registration'" });
      }

      if (id) {
        // ('phone-registration', defined, undefined): return a single registration if exists (filtered by handler)
        const registration = await PhoneRegistration.findByPk(id);
        if (!registration) {
          return res.status(404).send({ error: 'Phone endpoint not found' });
        }
        // Apply handler filter if provided
        if (handler && registration.handler !== handler) {
          return res.send({ items: [], nextOffset: null });
        }
        return res.send({
          items: [{
            id: registration.id,
            name: registration.name,
            handler: registration.handler,
            status: registration.status,
            state: registration.state,
            outbound: !!registration.outbound,
            instanceId: registration.instanceId,
            registrar: registration.registrar,
            options: registration.options,
          }],
          nextOffset: null
        });
      } else {
        // ('phone-registration', undefined, undefined): return all phone registrations, filtered by handler if specified
        const whereClause = {};
        if (handler) {
          whereClause.handler = handler;
        }

        const startOffset = Math.max(0, parseInt(offset || '0', 10) || 0);
        const size = Math.min(200, Math.max(1, parseInt(pageSize || '50', 10) || 50));

        const rows = await PhoneRegistration.findAll({ where: whereClause, limit: size, offset: startOffset });
        const items = rows.map(r => ({
          id: r.id,
          name: r.name,
          handler: r.handler,
          status: r.status,
          state: r.state,
          outbound: !!r.outbound,
          instanceId: r.instanceId,
        }));
        const nextOffset = rows.length === size ? startOffset + size : null;

        return res.send({ items, nextOffset });
      }
    }

    // If type is still not specified after inference, return error (type is required for listing)
    if (!type) {
      return res.status(400).send({ error: "Either 'type', 'id', or 'number' parameter is required" });
    }
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
      name: 'id',
      in: 'query',
      required: false,
      schema: {
        type: 'string',
        format: 'uuid'
      },
      description: 'Lookup phone endpoint by ID (PhoneRegistration). If provided, returns a single PhoneRegistration endpoint.'
    },
    {
      name: 'type',
      in: 'query',
      required: false,
      schema: {
        type: 'string',
        enum: ['e164-ddi', 'phone-registration']
      },
      description: 'Filter phone endpoints by endpoint type. Required when listing all endpoints (when neither id nor number is specified).'
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
    },
    {
      name: 'trunkId',
      in: 'query',
      required: false,
      schema: { type: 'string' },
      description: 'Trunk ID (aplisayId) for validation when looking up by number. If provided, validates that the call arrived on the same trunk that the number is assigned to. Returns 400 error if mismatch.'
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
                        aplisayId: { type: 'string', description: 'Trunk ID (aplisayId) assigned to this number', nullable: true },
                        trunk: {
                          type: 'object',
                          description: 'Trunk information (included when looking up by number and trunk exists)',
                          nullable: true,
                          properties: {
                            id: { type: 'string', description: 'Trunk ID' },
                            name: { type: 'string', description: 'Trunk name', nullable: true },
                            outbound: { type: 'boolean', description: 'Whether trunk supports outbound calls' },
                            flags: {
                              type: 'object',
                              description: 'Trunk flags (e.g., canRefer)',
                              nullable: true,
                              properties: {
                                canRefer: { type: 'boolean', description: 'Whether trunk supports SIP REFER for transfers' }
                              },
                              additionalProperties: true
                            }
                          }
                        },
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
    400: {
      description: 'Bad request (e.g., trunk mismatch when trunkId is provided)',
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
