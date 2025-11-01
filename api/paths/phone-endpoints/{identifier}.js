import { PhoneNumber, PhoneRegistration, Op } from '../../../lib/database.js';
import { normalizeE164, validateSipUri } from '../../../lib/validation.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: getPhoneEndpoint,
    PUT: updatePhoneEndpoint,
    DELETE: deletePhoneEndpoint
  };
};

const getPhoneEndpoint = async (req, res) => {
  const { organisationId } = res.locals.user || {};
  const { identifier } = req.params;

  try {
    if (!identifier) {
      return res.status(400).send({ error: 'Phone number or ID is required' });
    }

    let record = null;

    // number lookup
    if (identifier.match(/^\+?[0-9]+$/)) {
      const normalizedNumber = normalizeE164(identifier);
      if (!normalizedNumber) {
        return res.status(400).send({ error: 'Invalid phone number format' });
      }
      record = await PhoneNumber.findByPk(normalizedNumber);
    } else {
      // registration id lookup
      const registration = await PhoneRegistration.findByPk(identifier);
      if (!registration) {
        return res.status(404).send({ error: 'Phone endpoint not found' });
      }
      if (registration.organisationId && organisationId && registration.organisationId !== organisationId) {
        return res.status(403).send({ error: 'Access denied' });
      }
      return res.send({
        id: registration.id,
        name: registration.name,
        registrar: registration.registrar,
        username: registration.username,
        status: registration.status,
        state: registration.state,
        error: registration.error,
        handler: registration.handler,
        outbound: !!registration.outbound
      });
    }

    if (!record) {
      return res.status(404).send({ error: 'Phone endpoint not found' });
    }

    if (record.organisationId && organisationId && record.organisationId !== organisationId) {
      return res.status(403).send({ error: 'Access denied' });
    }

    // Return E.164 DDI endpoint shape
    return res.send({
      number: record.number,
      handler: record.handler,
      outbound: !!record.outbound
    });
  }
  catch (err) {
    req.log?.error(err, 'error fetching phone endpoint');
    return res.status(500).send({ error: 'Internal server error' });
  }
};

getPhoneEndpoint.apiDoc = {
  summary: 'Fetch a single phone endpoint by number or ID',
  operationId: 'getPhoneEndpoint',
  tags: ["Phone Endpoints"],
  parameters: [
    {
      name: 'identifier',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Phone number (E.164) or endpoint ID'
    }
  ],
  responses: {
    200: {
      description: 'Phone endpoint',
      content: {
        'application/json': {
          schema: {
            oneOf: [
              {
                type: 'object',
                description: 'E.164 DDI endpoint',
                required: ['number', 'handler', 'outbound'],
                properties: {
                  name: { type: 'string', description: 'User-defined descriptive name', nullable: true },
                  number: { type: 'string', description: 'The phone number' },
                  handler: { type: 'string', enum: ['livekit', 'jambonz'], description: 'Handler for this endpoint' },
                  outbound: { type: 'boolean', description: 'Supports outbound' }
                }
              },
              {
                type: 'object',
                description: 'Phone registration endpoint',
                required: ['id', 'handler', 'outbound'],
                properties: {
                  name: { type: 'string', description: 'User-defined descriptive name', nullable: true },
                  id: { type: 'string', description: 'Registration ID' },
                  registrar: { type: 'string', description: 'SIP contact URI' },
                  username: { type: 'string', description: 'Registration username' },
                  status: { type: 'string', enum: ['active', 'failed', 'disabled'] },
                  state: { type: 'string', enum: ['initial', 'registering', 'registered', 'failed'] },
                  error: { type: 'string', description: 'Error message if failed' },
                  handler: { type: 'string', enum: ['livekit', 'jambonz'], description: 'Handler for this endpoint' },
                  outbound: { type: 'boolean', description: 'Supports outbound' }
                }
              }
            ]
          }
        }
      }
    },
    400: {
      description: 'Bad request',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } }
      }
    },
    403: {
      description: 'Forbidden',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } }
      }
    },
    404: {
      description: 'Not found',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/NotFound' } }
      }
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } }
      }
    }
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
      // basic validation for number updates
      if (updateFields.outbound !== undefined && typeof updateFields.outbound !== 'boolean') {
        return res.status(400).send({ error: 'outbound must be a boolean value' });
      }
      if (updateFields.handler !== undefined && !['livekit', 'jambonz'].includes(updateFields.handler)) {
        return res.status(400).send({ error: 'handler must be one of: livekit, jambonz' });
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

      // field-level validation for registrations
      if (updateFields.outbound !== undefined && typeof updateFields.outbound !== 'boolean') {
        return res.status(400).send({ error: 'outbound must be a boolean value' });
      }
      if (updateFields.handler !== undefined && !['livekit', 'jambonz'].includes(updateFields.handler)) {
        return res.status(400).send({ error: 'handler must be one of: livekit, jambonz' });
      }
      if (updateFields.name !== undefined && typeof updateFields.name !== 'string') {
        return res.status(400).send({ error: 'name must be a string' });
      }
      
      // Handle credential rotation
      let credentialsChanged = false;
      for (const field of credentialFields) {
        if (updateData[field] !== undefined) {
          updateFields[field] = updateData[field];
          credentialsChanged = true;
        }
      }

      // validate credentials if provided
      if (updateFields.registrar !== undefined && !validateSipUri(updateFields.registrar)) {
        return res.status(400).send({ error: 'registrar must be a valid SIP contact URI' });
      }
      if (updateFields.username !== undefined && (typeof updateFields.username !== 'string' || updateFields.username.trim().length === 0)) {
        return res.status(400).send({ error: 'username must be a non-empty string' });
      }
      if (updateFields.password !== undefined && (typeof updateFields.password !== 'string' || updateFields.password.trim().length === 0)) {
        return res.status(400).send({ error: 'password must be a non-empty string' });
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
      // Registration ID - hard delete as per API spec
      const registration = await PhoneRegistration.findByPk(identifier);
      if (!registration) {
        return res.status(404).send({ error: 'Phone endpoint not found' });
      }
      if (registration.organisationId !== organisationId) {
        return res.status(403).send({ error: 'Access denied' });
      }

      // Hard delete the registration
      await registration.destroy();
      return res.send({
        success: true,
        message: 'Phone registration deleted successfully'
      });
    }
  } catch (err) {
    req.log.error(err, 'Error deleting phone endpoint');
    return res.status(500).send({
      error: 'Internal server error'
    });
  }
};

updatePhoneEndpoint.apiDoc = {
  summary: 'Update a phone endpoint',
  operationId: 'updatePhoneEndpoint',
  tags: ["Phone Endpoints"],
  parameters: [
    {
      name: 'identifier',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Phone number (E.164) or endpoint ID'
    }
  ],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'User-defined descriptive name' },
            outbound: { type: 'boolean', description: 'Supports outbound' },
            handler: { type: 'string', enum: ['livekit', 'jambonz'], description: 'Handler for this endpoint' },
            registrar: { type: 'string', description: 'SIP contact URI (for registrations)', pattern: '^sips?:(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9.-]+(?::[0-9]+)?(?:;transport=(?:tcp|udp|tls|TCP|UDP|TLS))?$' },
            username: { type: 'string', description: 'Registration username (for registrations)' },
            password: { type: 'string', description: 'Registration password (for registrations)' }
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
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean' }
            }
          }
        }
      }
    },
    400: {
      description: 'Bad request',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } }
      }
    },
    403: {
      description: 'Forbidden',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } }
      }
    },
    404: {
      description: 'Not found',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/NotFound' } }
      }
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } }
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
      schema: { type: 'string' },
      description: 'Phone number (E.164) or endpoint ID'
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
              success: { type: 'boolean' },
              message: { type: 'string' }
            }
          }
        }
      }
    },
    400: {
      description: 'Bad request',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } }
      }
    },
    403: {
      description: 'Forbidden',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } }
      }
    },
    404: {
      description: 'Not found',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/NotFound' } }
      }
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } }
      }
    }
  }
};


