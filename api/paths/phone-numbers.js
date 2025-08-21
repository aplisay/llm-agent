import { PhoneNumber } from '../../lib/database.js';

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
  let { originate } = req.query;
  
  try {
    let where = { organisationId };
    
    // If originate filter is requested, add additional conditions
    if (originate) {
      where.outbound = true;
      where.aplisayId = { [require('sequelize').Op.ne]: null };
    }
    
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
  summary: 'Returns a list of all phone numbers for the organization of the requestor. Optionally filter to only return numbers that can be used for outbound calling.',
  operationId: 'listPhoneNumbers',
  tags: ["Phone Numbers"],
  parameters: [
    {
      description: "Filter to only return numbers that can be used for outbound calling (outbound=true and aplisayId is not null)",
      in: 'query',
      name: 'originate',
      required: false,
      schema: {
        type: 'boolean'
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
