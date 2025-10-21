// Test-friendly API helpers that use the test database models
export function createTestPhoneEndpointList(models) {
  return async (req, res) => {
    try {
      const { organisationId } = res.locals.user || {};
      if (!organisationId) {
        return res.status(401).send({ error: 'Unauthorized' });
      }

      const { PhoneNumber, PhoneRegistration } = models;
      const { type, handler, outbound, offset = 0, limit = 50 } = req.query;

      // Build filters
      const whereClause = { organisationId };
      if (handler) whereClause.handler = handler;
      if (outbound !== undefined) whereClause.outbound = outbound === 'true';

      let phoneNumbers = [];
      let registrations = [];

      // Query phone numbers if type is not specified or is e164-ddi
      if (!type || type === 'e164-ddi') {
        phoneNumbers = await PhoneNumber.findAll({
          where: whereClause,
          limit: parseInt(limit),
          offset: parseInt(offset)
        });
      }

      // Query registrations if type is not specified or is phone-registration
      if (!type || type === 'phone-registration') {
        registrations = await PhoneRegistration.findAll({
          where: whereClause,
          limit: parseInt(limit),
          offset: parseInt(offset)
        });
      }

      // Apply pagination to combined results if no type filter is specified
      if (!type) {
        const allEndpoints = [
          ...phoneNumbers.map(pn => ({
            number: pn.number,
            name: pn.name,
            handler: pn.handler,
            outbound: !!pn.outbound
          })),
          ...registrations.map(reg => ({
            id: reg.id,
            name: reg.name,
            registrar: reg.registrar,
            username: reg.username,
            status: reg.status,
            state: reg.state,
            error: reg.error,
            handler: reg.handler,
            outbound: !!reg.outbound
          }))
        ];

        const startIndex = parseInt(offset);
        const endIndex = startIndex + parseInt(limit);
        const paginatedEndpoints = allEndpoints.slice(startIndex, endIndex);

        return res.send({
          endpoints: paginatedEndpoints,
          total: allEndpoints.length,
          offset: parseInt(offset),
          limit: parseInt(limit)
        });
      }

      // Combine and format results
      const endpoints = [
        ...phoneNumbers.map(pn => ({
          number: pn.number,
          name: pn.name,
          handler: pn.handler,
          outbound: !!pn.outbound
        })),
        ...registrations.map(reg => ({
          id: reg.id,
          name: reg.name,
          registrar: reg.registrar,
          username: reg.username,
          status: reg.status,
          state: reg.state,
          error: reg.error,
          handler: reg.handler,
          outbound: !!reg.outbound
        }))
      ];

      const total = phoneNumbers.length + registrations.length;

      return res.send({
        endpoints,
        total,
        offset: parseInt(offset),
        limit: parseInt(limit)
      });
    } catch (err) {
      console.error('Error in phoneEndpointList:', err);
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
}

export function createTestGetPhoneEndpoint(models) {
  return async (req, res) => {
    try {
      const { organisationId } = res.locals.user || {};
      if (!organisationId) {
        return res.status(401).send({ error: 'Unauthorized' });
      }

      const { identifier } = req.params;
      if (!identifier) {
        return res.status(400).send({ error: 'Identifier is required' });
      }

      const { PhoneNumber, PhoneRegistration } = models;

      let record = null;
      if (identifier.match(/^\+?[0-9]+$/)) {
        // E.164 number lookup
        record = await PhoneNumber.findByPk(identifier);
      } else {
        // Registration ID lookup - validate UUID format first
        if (!identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          return res.status(404).send({ error: 'Endpoint not found' });
        }
        record = await PhoneRegistration.findByPk(identifier);
      }

      if (!record) {
        return res.status(404).send({ error: 'Endpoint not found' });
      }

      if (record.organisationId && organisationId && record.organisationId !== organisationId) {
        return res.status(403).send({ error: 'Access denied' });
      }

      // Return appropriate shape based on record type
      if (record instanceof PhoneNumber) {
        return res.send({
          name: record.name,
          number: record.number,
          handler: record.handler,
          outbound: !!record.outbound
        });
      } else if (record instanceof PhoneRegistration) {
        return res.send({
          name: record.name,
          id: record.id,
          registrar: record.registrar,
          username: record.username,
          status: record.status,
          state: record.state,
          error: record.error,
          handler: record.handler,
          outbound: !!record.outbound
        });
      }
    } catch (err) {
      console.error('Error in getPhoneEndpoint:', err);
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
}

export function createTestCreatePhoneEndpoint(models) {
  return async (req, res) => {
    try {
      const { organisationId } = res.locals.user || {};
      if (!organisationId) {
        return res.status(401).send({ error: 'Unauthorized' });
      }

      const { type, ...data } = req.body;

      if (type === 'e164-ddi') {
        const { PhoneNumber } = models;
        const { number, name, handler, outbound } = data;

        if (!number) {
          return res.status(400).send({ error: 'Number is required for E.164 DDI' });
        }

        // Validate E.164 number
        if (!number.match(/^\+[1-9]\d{1,14}$/)) {
          return res.status(400).send({ error: 'Invalid E.164 number format' });
        }

        // Check for duplicates
        const existing = await PhoneNumber.findByPk(number);
        if (existing) {
          return res.status(409).send({ error: 'Phone number already exists' });
        }

        await PhoneNumber.create({
          number,
          organisationId,
          name,
          handler: handler || 'livekit',
          outbound: outbound || false
        });

        return res.status(201).send({ success: true, number });
      } else if (type === 'phone-registration') {
        const { PhoneRegistration } = models;
        const { name, registrar, username, password, handler, outbound } = data;

        if (!registrar || !username || !password) {
          return res.status(400).send({ error: 'Registrar, username, and password are required' });
        }

        // Validate SIP URI
        if (!registrar.match(/^sip:([a-zA-Z0-9-._~%!$&'()*+,;=:]+@)?([a-zA-Z0-9-._~%]+)(:[0-9]+)?$/)) {
          return res.status(400).send({ error: 'Invalid SIP URI format' });
        }

        const record = await PhoneRegistration.create({
          organisationId,
          name,
          handler: handler || 'livekit',
          outbound: outbound || false,
          registrar,
          username,
          password,
          options: {},
          status: 'active',
          state: 'initial'
        });

        return res.status(201).send({ success: true, id: record.id });
      } else {
        return res.status(400).send({ error: 'Invalid endpoint type' });
      }
    } catch (err) {
      console.error('Error in createPhoneEndpoint:', err);
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
}

export function createTestUpdatePhoneEndpoint(models) {
  return async (req, res) => {
    try {
      const { organisationId } = res.locals.user || {};
      if (!organisationId) {
        return res.status(401).send({ error: 'Unauthorized' });
      }

      const { identifier } = req.params;
      if (!identifier) {
        return res.status(400).send({ error: 'Identifier is required' });
      }

      const { PhoneNumber, PhoneRegistration } = models;
      const updateData = req.body;

      if (identifier.match(/^\+?[0-9]+$/)) {
        // E.164 number update
        const phoneNumber = await PhoneNumber.findByPk(identifier);
        if (!phoneNumber) {
          return res.status(404).send({ error: 'Phone number not found' });
        }
        if (phoneNumber.organisationId !== organisationId) {
          return res.status(403).send({ error: 'Access denied' });
        }

        const allowedFields = ['name', 'handler', 'outbound'];
        const updateFields = {};
        for (const field of allowedFields) {
          if (updateData[field] !== undefined) {
            updateFields[field] = updateData[field];
          }
        }

        await phoneNumber.update(updateFields);
        return res.send({ success: true });
      } else {
        // Registration update - validate UUID format first
        if (!identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          return res.status(404).send({ error: 'Registration not found' });
        }
        
        const registration = await PhoneRegistration.findByPk(identifier);
        if (!registration) {
          return res.status(404).send({ error: 'Registration not found' });
        }
        if (registration.organisationId !== organisationId) {
          return res.status(403).send({ error: 'Access denied' });
        }

        const allowedFields = ['outbound', 'handler', 'name'];
        const credentialFields = ['registrar', 'username', 'password'];
        const updateFields = {};

        for (const field of allowedFields) {
          if (updateData[field] !== undefined) {
            updateFields[field] = updateData[field];
          }
        }

        let credentialsChanged = false;
        for (const field of credentialFields) {
          if (updateData[field] !== undefined) {
            updateFields[field] = updateData[field];
            credentialsChanged = true;
          }
        }

        if (credentialsChanged) {
          updateFields.state = 'initial';
          updateFields.error = null;
        }

        await registration.update(updateFields);
        return res.send({ success: true });
      }
    } catch (err) {
      console.error('Error in updatePhoneEndpoint:', err);
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
}

export function createTestDeletePhoneEndpoint(models) {
  return async (req, res) => {
    try {
      const { organisationId } = res.locals.user || {};
      if (!organisationId) {
        return res.status(401).send({ error: 'Unauthorized' });
      }

      const { identifier } = req.params;
      if (!identifier) {
        return res.status(400).send({ error: 'Identifier is required' });
      }

      const { PhoneNumber, PhoneRegistration } = models;
      const { force } = req.query;

      if (identifier.match(/^\+?[0-9]+$/)) {
        // E.164 number deletion
        const phoneNumber = await PhoneNumber.findByPk(identifier);
        if (!phoneNumber) {
          return res.status(404).send({ error: 'Phone number not found' });
        }
        if (phoneNumber.organisationId !== organisationId) {
          return res.status(403).send({ error: 'Access denied' });
        }

        await phoneNumber.destroy();
        return res.send({ success: true });
      } else {
        // Registration deletion - validate UUID format first
        if (!identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          return res.status(404).send({ error: 'Registration not found' });
        }
        
        const registration = await PhoneRegistration.findByPk(identifier);
        if (!registration) {
          return res.status(404).send({ error: 'Registration not found' });
        }
        if (registration.organisationId !== organisationId) {
          return res.status(403).send({ error: 'Access denied' });
        }

        if (force === 'true') {
          await registration.destroy();
        } else {
          // Soft disable
          await registration.update({
            status: 'disabled',
            state: 'initial',
            error: null
          });
        }

        return res.send({ success: true });
      }
    } catch (err) {
      console.error('Error in deletePhoneEndpoint:', err);
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
}

export function createTestActivateRegistration(models) {
  return async (req, res) => {
    try {
      const { organisationId } = res.locals.user || {};
      if (!organisationId) {
        return res.status(401).send({ error: 'Unauthorized' });
      }

      const { identifier } = req.params;
      if (!identifier) {
        return res.status(400).send({ error: 'Identifier is required' });
      }

      // Check if it's an E.164 number (not a registration)
      if (identifier.match(/^\+?[0-9]+$/)) {
        return res.status(400).send({ error: 'Activation only supported for phone registrations' });
      }

      // Validate UUID format
      if (!identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        return res.status(404).send({ error: 'Registration not found' });
      }

      const { PhoneRegistration } = models;
      const registration = await PhoneRegistration.findByPk(identifier);
      if (!registration) {
        return res.status(404).send({ error: 'Registration not found' });
      }
      if (registration.organisationId !== organisationId) {
        return res.status(403).send({ error: 'Access denied' });
      }

      await registration.update({
        status: 'active',
        state: 'initial',
        error: null
      });

      return res.send({
        success: true,
        id: identifier,
        status: 'active',
        state: 'initial'
      });
    } catch (err) {
      console.error('Error in activateRegistration:', err);
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
}

export function createTestDisableRegistration(models) {
  return async (req, res) => {
    try {
      const { organisationId } = res.locals.user || {};
      if (!organisationId) {
        return res.status(401).send({ error: 'Unauthorized' });
      }

      const { identifier } = req.params;
      if (!identifier) {
        return res.status(400).send({ error: 'Identifier is required' });
      }

      // Check if it's an E.164 number (not a registration)
      if (identifier.match(/^\+?[0-9]+$/)) {
        return res.status(400).send({ error: 'Disable only supported for phone registrations' });
      }

      // Validate UUID format
      if (!identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        return res.status(404).send({ error: 'Registration not found' });
      }

      const { PhoneRegistration } = models;
      const registration = await PhoneRegistration.findByPk(identifier);
      if (!registration) {
        return res.status(404).send({ error: 'Registration not found' });
      }
      if (registration.organisationId !== organisationId) {
        return res.status(403).send({ error: 'Access denied' });
      }

      await registration.update({
        status: 'disabled',
        state: 'initial',
        error: null
      });

      return res.send({
        success: true,
        id: identifier,
        status: 'disabled',
        state: 'initial'
      });
    } catch (err) {
      console.error('Error in disableRegistration:', err);
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
}