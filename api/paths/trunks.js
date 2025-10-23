import { Trunk, Organisation, Op } from '../../lib/database.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: listTrunks
  };
};

const listTrunks = async (req, res) => {
  const { organisationId } = res.locals.user || {};
  const { offset, pageSize } = req.query || {};
  try {
    const startOffset = Math.max(0, parseInt(offset || '0', 10) || 0);
    const size = Math.min(200, Math.max(1, parseInt(pageSize || '50', 10) || 50));
    
    // Find trunks associated with the organisation through the many-to-many relationship
    const rows = await Trunk.findAll({
      include: [{
        model: Organisation,
        where: { id: organisationId },
        required: true
      }],
      attributes: ['id', 'name', 'outbound'],
      limit: size,
      offset: startOffset
    });
    
    const nextOffset = rows.length === size ? startOffset + size : null;
    res.send({ items: rows, nextOffset });
  }
  catch (err) {
    req.log?.error(err, 'listing trunks');
    res.status(500).send({ error: 'Internal server error' });
  }
};

listTrunks.apiDoc = {
  summary: 'Returns list of accessible trunks for the caller\'s organisation',
  description: `Returns a paginated list of trunks for the caller\'s organisation. 
                Trunks are used to assign numbers that then route via listeners to agents.
                The list of trunks available to an organisation is curated by the platform administrator
                and is read only by API users.`,
  operationId: 'listTrunks',
  tags: ['Phone Endpoints'],
  parameters: [
    {
      name: 'offset', in: 'query', required: false,
      schema: { type: 'integer', minimum: 0, default: 0 },
      description: 'Offset (0-based)'
    },
    {
      name: 'pageSize', in: 'query', required: false,
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      description: 'Page size (max 200)'
    }
  ],
  responses: {
    200: {
      description: 'List of trunks',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['items', 'nextOffset'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'outbound'],
                  properties: {
                    id: { type: 'string', description: 'Unique identifier for the trunk' },
                    name: { type: 'string', nullable: true, description: 'Free-form human name that identifies the trunk\'s purpose' },
                    outbound: { type: 'boolean', description: 'Whether this trunk can be used for outbound calls' }
                  }
                }
              },
              nextOffset: { type: 'integer', nullable: true, description: 'Next offset to request, or null if no more results' }
            }
          }
        }
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


