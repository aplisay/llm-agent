import { Trunk, Organisation, Op } from '../../lib/database.js';
import { requirePermission } from '../../lib/auth/permissions.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: listTrunks
  };
};

const listTrunks = async (req, res) => {
  if (!requirePermission(res, 'trunk', 'read')) return;
  const { organisationId } = res.locals.user || {};
  const { offset, pageSize, chargeable } = req.query || {};
  const chargeableOnly = chargeable === 'true' || chargeable === '1';
  try {
    const startOffset = Math.max(0, parseInt(offset || '0', 10) || 0);
    const size = Math.min(200, Math.max(1, parseInt(pageSize || '50', 10) || 50));

    // Chargeable trunks are shared platform carrier trunks that organisations
    // consume but do not own, so `chargeable=true` returns them GLOBALLY (no
    // TrunkOrganisation filter) — this is how a caller finds a buy target for a
    // number when their org owns no trunks. The default (unfiltered) listing
    // stays org-scoped: it answers "which trunks are MINE to route with".
    const rows = chargeableOnly
      ? await Trunk.findAll({
          where: { chargeable: true },
          attributes: ['id', 'name', 'handler', 'outbound', 'chargeable', 'flags'],
          order: [['id', 'ASC']],
          limit: size,
          offset: startOffset
        })
      : await Trunk.findAll({
          // Find trunks associated with the organisation through the many-to-many relationship
          include: [{
            model: Organisation,
            where: { id: organisationId },
            required: true
          }],
          attributes: ['id', 'name', 'handler', 'outbound', 'chargeable', 'flags'],
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
    },
    {
      name: 'chargeable', in: 'query', required: false,
      schema: { type: 'boolean' },
      description: 'When true, return the platform chargeable (carrier) trunks GLOBALLY, ignoring '
        + 'organisation assignment. These are shared trunks any organisation may allocate numbers '
        + 'onto (e.g. for the Buy-number flow); a chargeable trunk\'s flags.provider names the '
        + 'numbering provider it fronts. Omit for the default org-scoped listing.'
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
                    handler: { type: 'string', nullable: true, description: 'Telephony handler for this trunk (e.g. livekit, jambonz)' },
                    outbound: { type: 'boolean', description: 'Whether this trunk can be used for outbound calls' },
                    chargeable: { type: 'boolean', description: 'Whether outbound minutes on this trunk are destination-billed to the org (our carrier trunks); false for BYO/inbound/registration trunks' },
                    flags: { type: 'object', nullable: true, description: 'JSON object containing trunk flags (e.g., canRefer)' }
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


