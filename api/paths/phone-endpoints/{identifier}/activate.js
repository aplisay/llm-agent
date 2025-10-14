import { PhoneNumber, PhoneRegistration } from '../../../../lib/database.js';
import { normalizeE164 } from '../../../../lib/validation.js';

let log;

export default function (logger) {
  log = logger;
  return {
    POST: activateRegistration
  };
};

const activateRegistration = async (req, res) => {
  const { organisationId } = res.locals.user || {};
  const { identifier } = req.params;

  try {
    if (!identifier) {
      return res.status(400).send({ error: 'Phone number or ID is required' });
    }

    // Registrations are always IDs, not numbers
    if (identifier.match(/^\+?[0-9]+$/)) {
      return res.status(400).send({ error: 'Identifier must be a registration ID, not a phone number' });
    }

    const registration = await PhoneRegistration.findByPk(identifier);
    if (!registration) {
      return res.status(404).send({ error: 'Phone registration not found' });
    }
    if (registration.organisationId !== organisationId) {
      return res.status(403).send({ error: 'Access denied' });
    }

    // Update state to active and reset to initial state
    await registration.update({
      status: 'active',
      state: 'initial',
      error: null
    });

    // TODO: Emit worker signal for registration activation
    // This could be a database event, message queue, or webhook

    return res.send({ 
      success: true, 
      id: identifier, 
      status: 'active', 
      state: 'initial' 
    });
  }
  catch (err) {
    req.log?.error(err, 'activating registration');
    res.status(500).send({ error: 'Internal server error' });
  }
};

activateRegistration.apiDoc = {
  summary: 'Activate (enable) a phone endpoint registration by ID',
  description: 'Called initially to enable a registration, and may also be called to re-activate a registration that is in the failed state due to repeated registration failures. Note: registrations are always referenced by ID, not by phone number.',
  operationId: 'activatePhoneEndpoint',
  tags: ['Phone Endpoints'],
  parameters: [
    { name: 'identifier', in: 'path', required: true, schema: { type: 'string' }, description: 'Registration endpoint ID' }
  ],
  responses: {
    200: {
      description: 'Activation succeeded and returns new registration state',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['success','id','status','state'],
            properties: {
              success: { type: 'boolean' },
              id: { type: 'string', description: 'Registration endpoint ID' },
              status: { type: 'string', enum: ['active','failed','disabled'] },
              state: { type: 'string', enum: ['initial','registering','registered','failed'] }
            }
          }
        }
      }
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};


