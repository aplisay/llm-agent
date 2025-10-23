import { PhoneNumber, Op } from '../../lib/database.js';
import { getTelephonyHandler } from '../../lib/handlers/index.js';

// DEPRECATED: This endpoint is deprecated. Use /api/phone-endpoints instead.

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    GET: phoneNumberList
  };
};

const phoneNumberList = (async (req, res) => {
  let { organisationId } = res.locals.user;
  let { originate, handler } = req.query;

  try {
    let where = {
      [Op.or]: [
        { organisationId },
        {
          organisationId: {
            [Op.eq]: null
          }
        }
      ]
    };

    // If originate filter is requested, add additional conditions
    if (originate) {
      where.outbound = true;
      where.aplisayId = { [Op.ne]: null };
    }

    // If handler filter is requested, add handler condition
    if (handler) {
      const telephonyHandler = await getTelephonyHandler(handler);
      where.handler = telephonyHandler;
    }
    req.log.debug({ where }, 'listing phone numbers');

    let phoneNumbers = await PhoneNumber.findAll({
      where,
      attributes: ['number', 'handler', 'outbound']
    });
    res.send(phoneNumbers);
  }
  catch (err) {
    req.log.error(err, 'listing phone numbers');
    res.status(500).send(err);
  }
});

phoneNumberList.apiDoc = {
  summary: 'DEPRECATED: Returns a list of all phone numbers for the organization of the requestor. Optionally filter to only return numbers that can be used for outbound calling. Use /api/phone-endpoints instead.',
  description: '⚠️ DEPRECATED: This endpoint is deprecated and will be removed in a future version. Please use the Phone Endpoints API (/api/phone-endpoints) instead, which provides all the functionality of this API plus additional features like pagination, CRUD operations, and support for SIP registration endpoints.',
  operationId: 'listPhoneNumbers',
  tags: ["Phone Numbers", "Deprecated"],
  parameters: [
    {
      description: "Filter to only return numbers that can be used for outbound calling (outbound=true and aplisayId is not null)",
      in: 'query',
      name: 'originate',
      required: false,
      schema: {
        type: 'boolean'
      }
    },
    {
      description: "Filter to only return numbers using the specified handler. Handler names are mapped to their telephony handlers (e.g., 'ultravox' maps to 'jambonz')",
      in: 'query',
      name: 'handler',
      required: false,
      schema: {
        type: 'string',
        enum: ['livekit', 'jambonz', 'ultravox']
      }
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
                number: {
                  type: 'string',
                  description: 'The phone number'
                },
                handler: {
                  type: 'string',
                  enum: ['livekit', 'jambonz'],
                  description: 'The handler type for this phone number'
                },
                outbound: {
                  type: 'boolean',
                  description: 'Whether this number supports outbound calls'
                }
              }
            }
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
