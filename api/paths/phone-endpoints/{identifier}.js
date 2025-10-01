import { PhoneNumber, Op } from '../../../lib/database.js';
import { normalizeE164 } from '../../../lib/validation.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: getPhoneEndpoint
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
      // id lookup – currently no persisted phone-registration records; keep placeholder for future
      // record = await PhoneNumber.findOne({ where: { id: identifier } }); // no id field on PhoneNumber
      record = null;
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


