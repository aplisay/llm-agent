import { PhoneNumber, PhoneRegistration, Trunk, Organisation, Op } from '../../../lib/database.js';
import { normalizeE164, validateSipUri, isPlausibleSipHost, hasRoutableRegisterProxy, validateRegistrationTrunkFields } from '../../../lib/validation.js';
import { createRegistrationTrunk } from '../phone-endpoints.js';
import { TELEPHONY_HANDLER_NAMES } from '../../../lib/handlers/index.js';
import { userOwnsRow } from '../../../lib/scope.js';
import { requirePermission, can } from '../../../lib/auth/permissions.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Move a number between organisations, or into and out of the unallocated
 * pool (organisationId null). Platform operators only (phoneEndpoint:assign).
 *
 * Refused while the number is attached to an agent: the attachment belongs to
 * the organisation that made it, and moving the row under it would leave one
 * organisation's calls answered by another's agent. Detach first, then move.
 * The source row is the caller's own organisation's (or the pool's) unless
 * `fromOrganisationId` names another; a number is not unique on its own since
 * schema 61, so the source has to be said.
 */
async function movePhoneNumber(req, res, normalizedNumber) {
  if (!can(res.locals.user, 'phoneEndpoint', 'assign')) {
    return res.status(403).send({ error: 'Moving a number between organisations requires phoneEndpoint:assign' });
  }
  const { organisationId: to, fromOrganisationId } = req.body;
  const from = fromOrganisationId === undefined ? (res.locals.user.organisationId ?? null) : fromOrganisationId;
  if (to !== null && !(typeof to === 'string' && UUID.test(to))) {
    return res.status(400).send({ error: 'organisationId must be an organisation id, or null for the unallocated pool' });
  }
  if (from !== null && !(typeof from === 'string' && UUID.test(from))) {
    return res.status(400).send({ error: 'fromOrganisationId must be an organisation id, or null for the unallocated pool' });
  }

  const row = await PhoneNumber.findOne({ where: { number: normalizedNumber, organisationId: from } });
  if (!row) {
    return res.status(404).send({ error: 'Phone endpoint not found' });
  }
  if (to === from) {
    return res.send({ success: true, number: row.number, organisationId: to });
  }
  if (to && !(await Organisation.findByPk(to, { attributes: ['id'] }))) {
    return res.status(404).send({ error: 'Organisation not found' });
  }
  if (row.instanceId) {
    return res.status(409).send({
      error: 'This number is attached to an agent; detach it before moving it to another organisation',
      code: 'number_in_use',
    });
  }
  if (await PhoneNumber.findOne({ where: { number: normalizedNumber, organisationId: to }, attributes: ['id'] })) {
    return res.status(409).send({ error: 'The target organisation already holds this number' });
  }
  // A customer trunk (non-chargeable) is assigned to organisations; the
  // number cannot outrun its trunk. Carrier trunks are shared, so no check.
  if (to && row.aplisayId) {
    const trunk = await Trunk.findByPk(row.aplisayId);
    if (trunk && !trunk.chargeable && !(await trunk.hasOrganisation(to))) {
      return res.status(409).send({ error: "The number's trunk is not assigned to the target organisation" });
    }
  }
  try {
    await row.update({ organisationId: to });
  } catch (err) {
    if (err.code === 'number_in_use') {
      return res.status(409).send({ error: err.message, code: err.code });
    }
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).send({ error: 'The target organisation already holds this number' });
    }
    throw err;
  }
  return res.send({ success: true, number: row.number, organisationId: to });
}

/**
 * A DDI addressed by number, as the caller sees it: their organisation's own
 * row first, else the unallocated pool's (organisationId null). Identity is
 * (number, organisation) since schema 61, so the same number held by another
 * organisation is simply not found here.
 */
async function findOwnOrPoolNumber(number, organisationId) {
  return PhoneNumber.findOne({
    where: {
      number,
      [Op.or]: [{ organisationId: organisationId ?? null }, { organisationId: null }],
    },
    order: [[PhoneNumber.sequelize.literal('organisation_id IS NULL'), 'ASC']],
  });
}

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
  if (!requirePermission(res, 'phoneEndpoint', 'read')) return;
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
      // The caller's own row for this number, else the pool's (no
      // organisation). Another organisation's row for the same number is not
      // visible here at all.
      record = await findOwnOrPoolNumber(normalizedNumber, organisationId);
    } else {
      // registration id lookup
      const registration = await PhoneRegistration.findByPk(identifier);
      if (!registration) {
        return res.status(404).send({ error: 'Phone endpoint not found' });
      }
      if (!userOwnsRow(res.locals.user, registration)) {
        return res.status(403).send({ error: 'Access denied' });
      }
      return res.send({
        id: registration.id,
        name: registration.name,
        registrar: registration.registrar,
        username: registration.username,
        b2buaId: registration.b2buaId || null,
        status: registration.status,
        state: registration.state,
        error: registration.error,
        handler: registration.handler,
        outbound: !!registration.outbound,
        callReceived: registration.callReceived ? registration.callReceived.toISOString() : null,
        options: registration.options || null,
        trunkId: registration.trunkId || null,
        trunk: !!registration.trunkId,
        didSource: registration.didSource || null,
        didCountry: registration.didCountry || null
      });
    }

    if (!record) {
      return res.status(404).send({ error: 'Phone endpoint not found' });
    }

    if (record.organisationId != null && !userOwnsRow(res.locals.user, record)) {
      return res.status(403).send({ error: 'Access denied' });
    }

    // Return E.164 DDI endpoint shape
    return res.send({
      number: record.number,
      handler: record.handler,
      outbound: !!record.outbound,
      // Expose the associated trunk using the public trunkId field,
      // while keeping aplisayId as an internal implementation detail.
      trunkId: record.aplisayId || null,
      provisioned: !!record.provisioned,
      callReceived: record.callReceived ? record.callReceived.toISOString() : null,
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
                  handler: { type: 'string', enum: TELEPHONY_HANDLER_NAMES, description: 'Handler for this endpoint' },
                  outbound: { type: 'boolean', description: 'Supports outbound' },
                  trunkId: { type: 'string', nullable: true, description: 'Identifier of the trunk this number is assigned to (if any)' },
                  provisioned: { type: 'boolean', description: 'Whether the number provisioning onto the underlying telephony platforms has completed. This does not guarantee calls will arrive, only that local provisioning steps are complete.' },
                  callReceived: { type: 'string', format: 'date-time', nullable: true, description: 'Timestamp of the first inbound call received for this endpoint' },
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
                  handler: { type: 'string', enum: TELEPHONY_HANDLER_NAMES, description: 'Handler for this endpoint' },
                  outbound: { type: 'boolean', description: 'Supports outbound' },
                  callReceived: { type: 'string', format: 'date-time', nullable: true, description: 'Timestamp of the first inbound call received for this endpoint' },
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
  if (!requirePermission(res, 'phoneEndpoint', 'update')) return;
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
      if (updateData.organisationId !== undefined) {
        return movePhoneNumber(req, res, normalizedNumber);
      }
      const phoneNumber = await findOwnOrPoolNumber(normalizedNumber, organisationId);
      
      if (!phoneNumber) {
        return res.status(404).send({ error: 'Phone endpoint not found' });
      }
      if (phoneNumber.organisationId !== organisationId) {
        return res.status(403).send({ error: 'Access denied' });
      }

      // Update allowed fields for numbers. `provisioned` marks carrier-side
      // provisioning complete — set by the dashboard Buy-number flow once the
      // provider has activated and pointed the number at the platform.
      const allowedFields = ['outbound', 'handler', 'provisioned'];
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
      if (updateFields.provisioned !== undefined && typeof updateFields.provisioned !== 'boolean') {
        return res.status(400).send({ error: 'provisioned must be a boolean value' });
      }
      if (updateFields.handler !== undefined && !TELEPHONY_HANDLER_NAMES.includes(updateFields.handler)) {
        return res.status(400).send({ error: `handler must be one of: ${TELEPHONY_HANDLER_NAMES.join(', ')}` });
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
      const allowedFields = ['outbound', 'handler', 'name', 'options', 'b2buaId', 'didSource', 'didCountry'];
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
      if (updateFields.handler !== undefined && !TELEPHONY_HANDLER_NAMES.includes(updateFields.handler)) {
        return res.status(400).send({ error: `handler must be one of: ${TELEPHONY_HANDLER_NAMES.join(', ')}` });
      }
      if (updateFields.name !== undefined && typeof updateFields.name !== 'string') {
        return res.status(400).send({ error: 'name must be a string' });
      }
      if (updateFields.options !== undefined && typeof updateFields.options !== 'object') {
        return res.status(400).send({ error: 'options must be an object if provided' });
      }
      const trunkErrors = validateRegistrationTrunkFields(updateData);
      if (trunkErrors.length) {
        return res.status(400).send({ error: 'Validation failed', details: trunkErrors });
      }
      if (updateFields.didCountry) updateFields.didCountry = String(updateFields.didCountry).toUpperCase();
      // Turning a line into a trunk creates its trunks row and detaches it
      // from any single agent (a trunk's numbers are attached, not the trunk).
      // Turning a trunk back into a line needs the trunk to be empty first.
      let trunkChange = null;
      if (updateData.trunk === true && !registration.trunkId) trunkChange = 'create';
      if (updateData.trunk === false && registration.trunkId) {
        const numbers = await PhoneNumber.count({ where: { aplisayId: registration.trunkId } });
        if (numbers > 0) {
          return res.status(409).send({ error: `This trunk still carries ${numbers} number${numbers === 1 ? '' : 's'}. Remove them before turning it back into a line.` });
        }
        trunkChange = 'remove';
      }
      if (updateFields.b2buaId !== undefined) {
        if (updateFields.b2buaId === null || updateFields.b2buaId === '') {
          updateFields.b2buaId = null;
        } else if (typeof updateFields.b2buaId !== 'string' || !updateFields.b2buaId.trim()) {
          return res.status(400).send({ error: 'b2buaId must be a non-empty string when provided' });
        } else {
          updateFields.b2buaId = updateFields.b2buaId.trim();
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

      // validate credentials if provided. The registrar may be a non-FQDN host
      // when a routable register_proxy carries reachability — mirror the create
      // rule (see validatePhoneRegistration). The effective options are the
      // incoming ones (a full replace) when options is being updated, otherwise
      // those already stored on the registration.
      const effectiveOptions = updateFields.options !== undefined ? updateFields.options : registration.options;
      const registerProxyRoutable = hasRoutableRegisterProxy(effectiveOptions);
      if (updateFields.registrar !== undefined) {
        if (validateSipUri(updateFields.registrar)) {
          // routable registrar — fine
        } else if (registerProxyRoutable) {
          if (!isPlausibleSipHost(updateFields.registrar)) {
            return res.status(400).send({ error: 'registrar must be a valid SIP host' });
          }
        } else {
          return res.status(400).send({ error: 'registrar must be a valid SIP contact URI, or options.register_proxy must be set to a routable FQDN or public IP' });
        }
      }

      // Strip sip:/sips: prefix from registrar if present
      if (updateFields.registrar !== undefined) {
        updateFields.registrar = updateFields.registrar.replace(/^sips?:/i, '');
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
      
      await PhoneRegistration.sequelize.transaction(async (transaction) => {
      
        if (trunkChange === 'create') {
      
          const trunk = await createRegistrationTrunk(registration, null, organisationId, transaction);
      
          updateFields.trunkId = trunk.id;
      
          updateFields.instanceId = null;
      
        }
      
        if (trunkChange === 'remove') {
      
          await Trunk.destroy({ where: { id: registration.trunkId }, transaction });
      
          updateFields.trunkId = null;
      
        }
      
        await registration.update(updateFields, { transaction });
      
        // The trunk mirrors the registration's handler and outbound.
      
        if (registration.trunkId && (updateFields.handler !== undefined || updateFields.outbound !== undefined)) {
      
          await Trunk.update(
      
            { ...(updateFields.handler !== undefined ? { handler: updateFields.handler } : {}), ...(updateFields.outbound !== undefined ? { outbound: updateFields.outbound } : {}) },
      
            { where: { id: registration.trunkId }, transaction },
      
          );
      
        }
      
      });
      
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
  if (!requirePermission(res, 'phoneEndpoint', 'release')) return;
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
      const phoneNumber = await findOwnOrPoolNumber(normalizedNumber, organisationId);
      
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

      // A registration trunk goes with its registration, but not while
      // numbers still sit on it: those would silently lose their trunk.
      if (registration.trunkId) {
        const numbers = await PhoneNumber.count({ where: { aplisayId: registration.trunkId } });
        if (numbers > 0) {
          return res.status(409).send({ error: `This trunk still carries ${numbers} number${numbers === 1 ? '' : 's'}. Remove them before deleting the connection.` });
        }
      }
      // Hard delete the registration (and its trunk row)
      await PhoneRegistration.sequelize.transaction(async (transaction) => {
        if (registration.trunkId) await Trunk.destroy({ where: { id: registration.trunkId }, transaction });
        await registration.destroy({ transaction });
      });
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
          $ref: '#/components/schemas/PhoneEndpointUpdateInput'
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


