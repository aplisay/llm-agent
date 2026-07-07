import { Trunk, Organisation, Op } from '../../lib/database.js';
import { requirePermission } from '../../lib/auth/permissions.js';
import { TELEPHONY_HANDLER_NAMES } from '../../lib/handlers/index.js';

const TRUNK_ATTRS = ['id', 'name', 'handler', 'outbound', 'chargeable', 'flags'];
const withOrgs = { include: [{ model: Organisation, attributes: ['id'], through: { attributes: [] } }] };
const projectWithOrgs = (t) => ({
  id: t.id,
  name: t.name ?? null,
  handler: t.handler ?? null,
  outbound: !!t.outbound,
  chargeable: !!t.chargeable,
  flags: t.flags ?? null,
  organisationIds: (t.Organisations || []).map((o) => o.id),
});

let log;

export default function (logger) {
  log = logger;
  return {
    GET: listTrunks,
    POST: createTrunk
  };
};

const listTrunks = async (req, res) => {
  if (!requirePermission(res, 'trunk', 'read')) return;
  const { organisationId } = res.locals.user || {};
  const { offset, pageSize, chargeable, scope } = req.query || {};
  // NB: the `chargeable` query param is declared `type: boolean` in the apiDoc,
  // so express-openapi COERCES it to a real boolean (`true`) in the running app
  // — it only arrives as the string 'true' from raw/direct callers and tests.
  // Accept both, or the coerced boolean silently falls through to the org-scoped
  // branch (the same truthy convention the `originate` param relies on).
  const chargeableOnly = chargeable === true || chargeable === 'true' || chargeable === '1';
  const allScope = scope === 'all';
  // The cross-tenant "every trunk" view is a super-admin administration surface
  // (see + edit + assign to any org), so it needs `trunk:assign`, not just read.
  if (allScope && !requirePermission(res, 'trunk', 'assign')) return;
  try {
    const startOffset = Math.max(0, parseInt(offset || '0', 10) || 0);
    const size = Math.min(200, Math.max(1, parseInt(pageSize || '50', 10) || 50));

    // Three listing modes:
    //  - scope=all (super): EVERY trunk, each with its organisationIds, for the
    //    admin trunk manager.
    //  - chargeable=true: the shared platform carrier trunks GLOBALLY (orgs
    //    consume but don't own them) — how a caller finds a buy target.
    //  - default: org-scoped — "which trunks are MINE to route with".
    let rows;
    let mapped;
    if (allScope) {
      rows = await Trunk.findAll({ ...withOrgs, order: [['id', 'ASC']], limit: size, offset: startOffset });
      mapped = rows.map(projectWithOrgs);
    } else if (chargeableOnly) {
      rows = await Trunk.findAll({
        where: { chargeable: true },
        attributes: TRUNK_ATTRS,
        order: [['id', 'ASC']],
        limit: size,
        offset: startOffset
      });
      mapped = rows;
    } else {
      rows = await Trunk.findAll({
        // Find trunks associated with the organisation through the many-to-many relationship
        include: [{ model: Organisation, where: { id: organisationId }, required: true }],
        attributes: TRUNK_ATTRS,
        limit: size,
        offset: startOffset
      });
      mapped = rows;
    }

    const nextOffset = rows.length === size ? startOffset + size : null;
    res.send({ items: mapped, nextOffset });
  }
  catch (err) {
    req.log?.error(err, 'listing trunks');
    res.status(500).send({ error: 'Internal server error' });
  }
};

const TRUNK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Create a trunk (super admin, `trunk:create`). Trunks are a curated platform
 * resource; the `id` is an admin-supplied stable identifier (it is what numbers
 * reference via aplisayId and typically mirrors the carrier/telephony platform
 * trunk), NOT generated. Optionally chargeable (a shared carrier trunk) with a
 * `provider` tag, and assigned to organisations up-front.
 */
const createTrunk = async (req, res) => {
  if (!requirePermission(res, 'trunk', 'create')) return;
  const { id, name, handler, outbound, chargeable, provider, organisationIds } = req.body || {};

  const trunkId = typeof id === 'string' ? id.trim() : '';
  if (!TRUNK_ID_RE.test(trunkId)) {
    return res.status(400).send({ message: 'id is required: 1–128 chars, letters/digits/._- and must start alphanumeric' });
  }
  if (handler !== undefined && handler !== null && !TELEPHONY_HANDLER_NAMES.includes(handler)) {
    return res.status(400).send({ message: `handler must be one of: ${TELEPHONY_HANDLER_NAMES.join(', ')}` });
  }
  if (provider !== undefined && provider !== null && typeof provider !== 'string') {
    return res.status(400).send({ message: 'provider must be a string, or null' });
  }
  if (outbound !== undefined && typeof outbound !== 'boolean') {
    return res.status(400).send({ message: 'outbound must be a boolean' });
  }
  if (chargeable !== undefined && typeof chargeable !== 'boolean') {
    return res.status(400).send({ message: 'chargeable must be a boolean' });
  }

  // Validate the org-assignment set up-front so a bad id fails cleanly.
  let orgs = null;
  if (organisationIds !== undefined) {
    if (!Array.isArray(organisationIds) || organisationIds.some((o) => typeof o !== 'string')) {
      return res.status(400).send({ message: 'organisationIds must be an array of organisation ids' });
    }
    const unique = [...new Set(organisationIds)];
    orgs = await Organisation.findAll({ where: { id: unique }, attributes: ['id'] });
    if (orgs.length !== unique.length) {
      return res.status(400).send({ message: 'One or more organisationIds do not exist' });
    }
  }

  try {
    const existing = await Trunk.findByPk(trunkId);
    if (existing) {
      return res.status(409).send({ message: `Trunk ${trunkId} already exists` });
    }

    const flags = {};
    if (typeof provider === 'string' && provider.trim()) flags.provider = provider.trim();

    await Trunk.sequelize.transaction(async (transaction) => {
      const trunk = await Trunk.create({
        id: trunkId,
        name: typeof name === 'string' && name.trim() ? name.trim() : null,
        handler: handler ?? null,
        outbound: !!outbound,
        chargeable: !!chargeable,
        flags: Object.keys(flags).length ? flags : null,
      }, { transaction });
      if (orgs && orgs.length) await trunk.setOrganisations(orgs, { transaction });
    });

    const fresh = await Trunk.findByPk(trunkId, withOrgs);
    return res.status(201).send(projectWithOrgs(fresh));
  }
  catch (err) {
    // Unique-violation backstop for a race between the pre-check and create.
    if (err?.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).send({ message: `Trunk ${trunkId} already exists` });
    }
    log?.error({ err: err?.message }, 'creating trunk');
    return res.status(400).send({ message: err?.message || 'Failed to create trunk' });
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
    },
    {
      name: 'scope', in: 'query', required: false,
      schema: { type: 'string', enum: ['all'] },
      description: 'scope=all (super admin, `trunk:assign`) returns EVERY trunk on the platform, '
        + 'each with its organisationIds, for the admin trunk manager (see + edit + assign to any '
        + 'org). Ignored/forbidden for non-super callers.'
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
                    flags: { type: 'object', nullable: true, description: 'JSON object containing trunk flags (e.g., canRefer, provider)' },
                    organisationIds: { type: 'array', items: { type: 'string' }, description: 'Organisations this trunk is assigned to (only present for scope=all)' }
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

createTrunk.apiDoc = {
  summary: 'Create a trunk (super admin).',
  description: `Create a platform trunk. Trunks are a curated resource; the id is an
                admin-supplied stable identifier (it is what phone numbers reference and
                typically mirrors the carrier / telephony platform trunk), not generated.
                A chargeable trunk is a shared carrier trunk (any org may allocate numbers
                onto it) and may carry a numbering provider tag; it can be assigned to
                organisations up-front.`,
  operationId: 'createTrunk',
  tags: ['Phone Endpoints'],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Stable trunk identifier (1–128 chars, letters/digits/._- , starts alphanumeric)' },
            name: { type: 'string', nullable: true, description: 'Free-form human name' },
            handler: { type: 'string', enum: TELEPHONY_HANDLER_NAMES, nullable: true, description: 'Telephony handler this trunk routes via' },
            outbound: { type: 'boolean', default: false, description: 'Whether the trunk supports outbound calls' },
            chargeable: { type: 'boolean', default: false, description: 'Shared carrier trunk whose outbound minutes are destination-billed' },
            provider: { type: 'string', nullable: true, description: 'Numbering provider a chargeable trunk fronts (stored under flags.provider)' },
            organisationIds: { type: 'array', items: { type: 'string' }, description: 'Organisations to assign this trunk to' }
          }
        }
      }
    }
  },
  responses: {
    201: { description: 'Created trunk (with organisationIds)' },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    409: { description: 'A trunk with this id already exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};


