import { PhoneNumber, PhoneRegistration, Trunk, Organisation, Op } from '../../lib/database.js';
import { getTelephonyHandler } from '../../lib/handlers/index.js';
import { validateE164, normalizeE164, validateSipUri, validatePhoneRegistration, validateE164Ddi } from '../../lib/validation.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    GET: phoneEndpointList,
    POST: createPhoneEndpoint,
    PUT: updatePhoneEndpoint,
    DELETE: deletePhoneEndpoint
  };
};

const phoneEndpointList = (async (req, res) => {
  let { organisationId } = res.locals.user;
  let { originate, handler, type, offset, pageSize } = req.query;

  try {
    const startOffset = Math.max(0, parseInt(offset || '0', 10) || 0);
    const size = Math.min(200, Math.max(1, parseInt(pageSize || '50', 10) || 50));

    const telephonyHandler = handler ? await getTelephonyHandler(handler) : null;

    // Build where clauses per model
    const numberWhere = {
      [Op.or]: [
        { organisationId },
        { organisationId: { [Op.eq]: null } }
      ]
    };
    if (originate) {
      numberWhere.outbound = true;
      numberWhere.aplisayId = { [Op.ne]: null };
    }
    if (telephonyHandler) {
      numberWhere.handler = telephonyHandler;
    }

    const regWhere = {
      organisationId
    };
    if (originate) {
      regWhere.outbound = true;
    }
    if (telephonyHandler) {
      regWhere.handler = telephonyHandler;
    }

    // If only one type requested, short-circuit and return that type paginated
    if (type === 'e164-ddi') {
      const rows = await PhoneNumber.findAll({
        where: numberWhere,
        attributes: ['number', 'handler', 'outbound'],
        limit: size,
        offset: startOffset
      });
      const nextOffset = rows.length === size ? startOffset + size : null;
      return res.send({ items: rows, nextOffset });
    }
    if (type === 'phone-registration') {
      const rows = await PhoneRegistration.findAll({
        where: regWhere,
        limit: size,
        offset: startOffset
      });
      const items = rows.map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        state: r.state,
        handler: r.handler,
        outbound: !!r.outbound
      }));
      const nextOffset = rows.length === size ? startOffset + size : null;
      return res.send({ items, nextOffset });
    }

    // Both types: fetch a window from each, merge, and page
    const [numRows, regRows] = await Promise.all([
      PhoneNumber.findAll({
        where: numberWhere,
        attributes: ['number', 'handler', 'outbound', 'createdAt'],
        limit: size,
        offset: startOffset
      }),
      PhoneRegistration.findAll({
        where: regWhere,
        attributes: ['id', 'name', 'status', 'state', 'handler', 'outbound', 'createdAt'],
        limit: size,
        offset: startOffset
      })
    ]);

    const mappedNumbers = numRows.map(n => ({
      number: n.number,
      handler: n.handler,
      outbound: !!n.outbound,
      _createdAt: n.createdAt
    }));
    const mappedRegs = regRows.map(r => ({
      id: r.id,
      name: r.name,
      status: r.status,
      state: r.state,
      handler: r.handler,
      outbound: !!r.outbound,
      _createdAt: r.createdAt
    }));

    const merged = [...mappedNumbers, ...mappedRegs]
      .sort((a, b) => new Date(b._createdAt) - new Date(a._createdAt))
      .slice(0, size)
      .map(({ _createdAt, ...rest }) => rest);

    const nextOffset = (numRows.length === size || regRows.length === size) ? startOffset + size : null;
    return res.send({ items: merged, nextOffset });
  }
  catch (err) {
    req.log.error(err, 'listing phone endpoints');
    res.status(500).send(err);
  }
});

const createPhoneEndpoint = async (req, res) => {
  const { organisationId } = res.locals.user;
  const { type, ...data } = req.body;

  try {
    if (!type || !['e164-ddi', 'phone-registration'].includes(type)) {
      return res.status(400).send({
        error: 'Invalid type. Must be either "e164-ddi" or "phone-registration"'
      });
    }

    if (type === 'e164-ddi') {
      // Support public field name `number`; keep backward-compat with `phoneNumber`
      data.phoneNumber = data.phoneNumber || data.number;
      const validation = validateE164Ddi(data);
      if (!validation.isValid) {
        return res.status(400).send({
          error: 'Validation failed',
          details: validation.errors
        });
      }

      const normalizedNumber = normalizeE164(data.phoneNumber);
      
      // Check if number already exists
      const existingNumber = await PhoneNumber.findByPk(normalizedNumber);
      if (existingNumber) {
        return res.status(409).send({
          error: 'Phone number already exists'
        });
      }

      // Validate that the trunk exists and is associated with the organization
      const trunk = await Trunk.findByPk(data.trunkId, {
        include: [{
          model: Organisation,
          where: { id: organisationId },
          required: true
        }]
      });
      
      if (!trunk) {
        return res.status(400).send({
          error: 'Trunk not found or not associated with your organization'
        });
      }

      const phoneNumber = await PhoneNumber.create({
        number: normalizedNumber,
        handler: data.handler ?? 'livekit',
        outbound: data.outbound ?? false,
        organisationId: organisationId,
        // Store additional data in a JSON field if needed
        trunkId: data.trunkId
      });

      return res.status(201).send({ success: true, number: phoneNumber.number });
    }

    if (type === 'phone-registration') {
      const validation = validatePhoneRegistration(data);
      if (!validation.isValid) {
        return res.status(400).send({
          error: 'Validation failed',
          details: validation.errors
        });
      }

      const record = await PhoneRegistration.create({
        name: data.name,
        handler: data.handler ?? 'livekit',
        outbound: data.outbound ?? false,
        registrar: data.registrar,
        username: data.username,
        password: data.password,
        options: data.options || null,
        organisationId,
        status: 'disabled',
        state: 'initial'
      });

      return res.status(201).send({ success: true, id: record.id });
    }
  } catch (err) {
    req.log.error(err, 'Error creating phone endpoint');
    return res.status(500).send({
      error: 'Internal server error'
    });
  }
};

const updatePhoneEndpoint = async (req, res) => {
  const { organisationId } = res.locals.user;
  const { identifier } = req.params;
  const updateData = req.body;

  try {
    if (!identifier) {
      return res.status(400).send({
        error: 'Phone number or ID is required'
      });
    }

    // Check if identifier is a phone number (contains digits and possibly +)
    if (identifier.match(/^\+?[0-9]+$/)) {
      const normalizedNumber = normalizeE164(identifier);
      const phoneNumber = await PhoneNumber.findByPk(normalizedNumber);
      
      if (!phoneNumber) {
        return res.status(404).send({ error: 'Phone endpoint not found' });
      }
      if (phoneNumber.organisationId !== organisationId) {
        return res.status(403).send({ error: 'Access denied' });
      }

      // Update allowed fields for numbers
      const allowedFields = ['outbound', 'handler'];
      const updateFields = {};
      for (const field of allowedFields) {
        if (updateData[field] !== undefined) {
          updateFields[field] = updateData[field];
        }
      }
      await phoneNumber.update(updateFields);
      return res.send({ success: true });
    } else {
      // Registration ID
      const registration = await PhoneRegistration.findByPk(identifier);
      if (!registration) {
        return res.status(404).send({ error: 'Phone endpoint not found' });
      }
      if (registration.organisationId !== organisationId) {
        return res.status(403).send({ error: 'Access denied' });
      }

      // Update allowed fields for registrations
      const allowedFields = ['outbound', 'handler', 'name'];
      const credentialFields = ['registrar', 'username', 'password'];
      const updateFields = {};
      
      for (const field of allowedFields) {
        if (updateData[field] !== undefined) {
          updateFields[field] = updateData[field];
        }
      }
      
      // Handle credential rotation
      let credentialsChanged = false;
      for (const field of credentialFields) {
        if (updateData[field] !== undefined) {
          updateFields[field] = updateData[field];
          credentialsChanged = true;
        }
      }
      
      // If credentials changed, reset state to initial for re-registration
      if (credentialsChanged) {
        updateFields.state = 'initial';
        updateFields.error = null;
      }
      
      await registration.update(updateFields);
      
      // TODO: Emit worker signal for credential rotation if credentialsChanged
      
      return res.send({ success: true });
    }
  } catch (err) {
    req.log.error(err, 'Error updating phone endpoint');
    return res.status(500).send({
      error: 'Internal server error'
    });
  }
};

const deletePhoneEndpoint = async (req, res) => {
  const { organisationId } = res.locals.user;
  const { identifier } = req.params;
  const { force } = req.query;

  try {
    if (!identifier) {
      return res.status(400).send({
        error: 'Phone number or ID is required'
      });
    }

    // Check if identifier is a phone number (contains digits and possibly +)
    if (identifier.match(/^\+?[0-9]+$/)) {
      const normalizedNumber = normalizeE164(identifier);
      const phoneNumber = await PhoneNumber.findByPk(normalizedNumber);
      
      if (!phoneNumber) {
        return res.status(404).send({ error: 'Phone endpoint not found' });
      }
      if (phoneNumber.organisationId !== organisationId) {
        return res.status(403).send({ error: 'Access denied' });
      }

      await phoneNumber.destroy();
      return res.send({
        success: true,
        message: 'Phone endpoint deleted successfully'
      });
    } else {
      // Registration ID
      const registration = await PhoneRegistration.findByPk(identifier);
      if (!registration) {
        return res.status(404).send({ error: 'Phone endpoint not found' });
      }
      if (registration.organisationId !== organisationId) {
        return res.status(403).send({ error: 'Access denied' });
      }

      if (force === 'true') {
        // Hard delete
        await registration.destroy();
        return res.send({
          success: true,
          message: 'Phone registration deleted successfully'
        });
      } else {
        // Soft disable
        await registration.update({
          status: 'disabled',
          state: 'initial',
          error: null
        });
        return res.send({
          success: true,
          message: 'Phone registration disabled successfully'
        });
      }
    }
  } catch (err) {
    req.log.error(err, 'Error deleting phone endpoint');
    return res.status(500).send({
      error: 'Internal server error'
    });
  }
};

phoneEndpointList.apiDoc = {
  summary: 'Returns a list of all phone endpoints for the organization of the requestor. Optionally filter to only certain endpoint types.',
  description: `Returns a paginated list of phone endpoints for the caller\'s organisation. 
                Phone endpoints are used to assign numbers that then route via handlers and listeners to agents.
                Both E.164 DDI number and phone SIPregistration endpoints are supported.
                DDI numbers are assigned to trunks which are then used to route calls to agents.
                SIP registration endpoints are used to register with a SIP provider and identified by a unique
                non phone number like ID (UUID).`,
  operationId: 'listPhoneEndpoints',
  tags: ["Phone Endpoints"],
  parameters: [
    {
      description: "Filter to only return endpoints that can be used for outbound calling (outbound=true and aplisayId is not null)",
      in: 'query',
      name: 'originate',
      required: false,
      schema: {
        type: 'boolean'
      }
    },
    {
      description: "Filter to only return endpoints using the specified handler. Handler names are mapped to their telephony handlers (e.g., 'ultravox' maps to 'jambonz')",
      in: 'query',
      name: 'handler',
      required: false,
      schema: {
        type: 'string',
        enum: ['livekit', 'jambonz', 'ultravox']
      }
    },
    {
      description: "Filter by endpoint type",
      in: 'query',
      name: 'type',
      required: false,
      schema: {
        type: 'string',
        enum: ['e164-ddi', 'phone-registration']
      }
    },
    {
      description: "Offset (0-based)",
      in: 'query',
      name: 'offset',
      required: false,
      schema: {
        type: 'integer',
        minimum: 0,
        default: 0
      }
    },
    {
      description: "Page size (max 200)",
      in: 'query',
      name: 'pageSize',
      required: false,
      schema: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50
      }
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
                      required: ['number', 'handler', 'outbound'],
                      properties: {
                        name: { type: 'string', description: 'User-defined descriptive name', nullable: true },
                        number: { type: 'string', description: 'The phone number' },
                        handler: { type: 'string', enum: ['livekit', 'jambonz'], description: 'The handler type for this phone endpoint' },
                        outbound: { type: 'boolean', description: 'Whether this endpoint supports outbound calls', default: false }
                      }
                    },
                    {
                      type: 'object',
                      description: 'Phone registration endpoint',
                      required: ['id', 'handler', 'outbound'],
                      properties: {
                        name: { type: 'string', description: 'User-defined descriptive name', nullable: true },
                        id: { type: 'string', description: 'The registration ID' },
                        status: { type: 'string', description: 'High-level status of the endpoint', enum: ['active', 'failed', 'disabled'] },
                        state: { type: 'string', description: 'Registration state', enum: ['initial', 'registering', 'registered', 'failed'] },
                        handler: { type: 'string', enum: ['livekit', 'jambonz'], description: 'The handler type for this phone endpoint' },
                        outbound: { type: 'boolean', description: 'Whether this endpoint supports outbound calls', default: false }
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

createPhoneEndpoint.apiDoc = {
  summary: 'Create a new phone endpoint',
  description: `Creates a new phone endpoint. Supports two types of endpoints:
                DDI endpoints are created using an E.164 phone number with trunk configuration.
                Phone registration endpoints are created using a SIP contact URI, username, and password.
                Both kinds of endpoints can be created with a user-defined descriptive name and optionally set to support outbound calling
                (if supported by the handler and trunk/registration account).`,
  operationId: 'createPhoneEndpoint',
  tags: ["Phone Endpoints"],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          allOf: [
            {
              type: 'object',
              required: ['type'],
              properties: {
                type: {
                  type: 'string',
                  description: 'The type of phone endpoint',
                  enum: ['e164-ddi', 'phone-registration']
                },
                name: {
                  type: 'string',
                  description: 'User-defined descriptive name',
                  nullable: true
                },
                handler: {
                  type: 'string',
                  description: 'The handler type for this phone endpoint',
                  enum: ['livekit', 'jambonz'],
                  default: 'livekit'
                },
                outbound: {
                  type: 'boolean',
                  description: 'Whether this endpoint supports outbound calls',
                  default: false
                }
              }
            },
            {
              oneOf: [
                {
                  description: 'E.164 DDI endpoint',
                  type: 'object',
                  required: ['number', 'trunkId'],
                  properties: {
                    name: {
                      type: 'string',
                      description: 'User-defined descriptive name',
                      nullable: true
                    },
                    number: {
                      type: 'string',
                      description: 'E.164 phone number (with or without +)',
                      pattern: '^\\+?[1-9]\\d{6,14}$'
                    },
                    trunkId: {
                      type: 'string',
                      description: 'Trunk identifier for e164-ddi type'
                    }
                  }
                },
                {
                  description: 'Phone registration endpoint',
                  type: 'object',
                  required: ['registrar', 'username', 'password'],
                  properties: {
                    name: {
                      type: 'string',
                      description: 'User-defined descriptive name',
                      nullable: true
                    },
                    registrar: {
                      type: 'string',
                      description: 'SIP contact URI for phone-registration type',
                      pattern: '^sip:(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9.-]+(?::[0-9]+)?$'
                    },
                    username: {
                      type: 'string',
                      description: 'Username for phone-registration type'
                    },
                    password: {
                      type: 'string',
                      description: 'Password for phone-registration type'
                    },
                    options: {
                      type: 'object',
                      description: 'Implementation-specific options (TBD)'
                    }
                  }
                }
              ]
            }
          ]
        }
      }
    }
  },
  responses: {
    201: {
      description: 'Phone endpoint created successfully',
      content: {
        'application/json': {
          schema: {
            allOf: [
              {
                type: 'object',
                description: 'Base response - success is always present',
                required: ['success'],
                properties: {
                  success: { type: 'boolean', example: true, description: 'Always true on success' }
                }
              },
              {
                oneOf: [
                  {
                    type: 'object',
                    description: 'Response when type is e164-ddi',
                    required: ['number'],
                    properties: {
                      number: { type: 'string', description: 'E.164 number created (no +)' }
                    }
                  },
                  {
                    type: 'object',
                    description: 'Response when type is phone-registration',
                    required: ['id'],
                    properties: {
                      id: { type: 'string', description: 'Registration id for the created phone registration' }
                    }
                  }
                ]
              }
            ]
          }
        }
      }
    },
    400: {
      description: 'Bad request - validation failed or trunk not found',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string',
                example: 'Validation failed'
              },
              details: {
                type: 'array',
                items: {
                  type: 'string'
                }
              }
            }
          }
        }
      }
    },
    409: {
      description: 'Conflict - phone number already exists',
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

updatePhoneEndpoint.apiDoc = {
  summary: 'Update an existing phone endpoint',
  operationId: 'updatePhoneEndpoint',
  tags: ["Phone Endpoints"],
  parameters: [
    {
      name: 'identifier',
      in: 'path',
      required: true,
      schema: {
        type: 'string'
      },
      description: 'The phone number (E.164 format) or ID of the phone endpoint to update'
    }
  ],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            handler: {
              type: 'string',
              enum: ['livekit', 'jambonz'],
              description: 'The handler type for this phone endpoint'
            },
            outbound: {
              type: 'boolean',
              description: 'Whether this endpoint supports outbound calls'
            }
          }
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Phone endpoint updated successfully',
      content: {
        'application/json': {
          schema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] }
        }
      }
    },
    400: {
      description: 'Bad request',
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
      description: 'Phone endpoint not found',
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

deletePhoneEndpoint.apiDoc = {
  summary: 'Delete a phone endpoint',
  operationId: 'deletePhoneEndpoint',
  tags: ["Phone Endpoints"],
  parameters: [
    {
      name: 'identifier',
      in: 'path',
      required: true,
      schema: {
        type: 'string'
      },
      description: 'The phone number (E.164 format) or ID of the phone endpoint to delete'
    }
  ],
  responses: {
    200: {
      description: 'Phone endpoint deleted successfully',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              success: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    400: {
      description: 'Bad request',
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
      description: 'Phone endpoint not found',
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


