import { Trunk, Organisation } from '../../../lib/database.js';
import { requirePermission } from '../../../lib/auth/permissions.js';

/**
 * /api/trunks/{trunkId} (item) — superAdmin-only trunk administration.
 *
 * Trunks are a platform resource curated by staff (the list endpoint is
 * read-only to ordinary API users). The one mutation is assigning a trunk to
 * organisations and configuring its billing posture, gated on the super-only
 * `trunk:assign` action — owner/orgAdmin/member/support hold `trunk:read`
 * only (see lib/auth/permissions.js). The full org-assignment set is likewise
 * assignment-gated so trunk sharing isn't leaked cross-tenant.
 *
 *   GET   full trunk incl. its organisation assignments (organisationIds).
 *   PATCH edit name / chargeable ("billable") / organisation assignments.
 */
export default function (logger) {
  // Project a Trunk row (with an eager Organisations include) to the wire shape.
  const project = (trunk) => ({
    id: trunk.id,
    name: trunk.name ?? null,
    handler: trunk.handler ?? null,
    outbound: !!trunk.outbound,
    chargeable: !!trunk.chargeable,
    flags: trunk.flags ?? null,
    organisationIds: (trunk.Organisations || []).map((o) => o.id),
  });

  const withOrgs = { include: [{ model: Organisation, attributes: ['id'], through: { attributes: [] } }] };

  const get = async (req, res) => {
    if (!requirePermission(res, 'trunk', 'assign')) return;
    const trunk = await Trunk.findByPk(req.params.trunkId, withOrgs);
    if (!trunk) return res.status(404).send({ message: `Trunk ${req.params.trunkId} not found` });
    return res.send(project(trunk));
  };
  get.apiDoc = {
    summary: 'Get a trunk with its organisation assignments (super admin).',
    operationId: 'getTrunk',
    tags: ['Phone Endpoints'],
    parameters: [{ in: 'path', name: 'trunkId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Trunk' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const update = async (req, res) => {
    if (!requirePermission(res, 'trunk', 'assign')) return;
    const trunk = await Trunk.findByPk(req.params.trunkId, withOrgs);
    if (!trunk) return res.status(404).send({ message: `Trunk ${req.params.trunkId} not found` });

    const { name, chargeable, organisationIds, provider } = req.body || {};

    if (provider !== undefined && provider !== null && typeof provider !== 'string') {
      return res.status(400).send({ message: 'provider must be a string, or null to clear it' });
    }

    // Validate the assignment set up-front (before any write) so a bad org id
    // fails cleanly rather than part-applying the trunk field edits.
    let orgs = null;
    if (organisationIds !== undefined) {
      if (!Array.isArray(organisationIds) || organisationIds.some((id) => typeof id !== 'string')) {
        return res.status(400).send({ message: 'organisationIds must be an array of organisation ids' });
      }
      const unique = [...new Set(organisationIds)];
      orgs = await Organisation.findAll({ where: { id: unique }, attributes: ['id'] });
      if (orgs.length !== unique.length) {
        return res.status(400).send({ message: 'One or more organisationIds do not exist' });
      }
    }

    try {
      await Trunk.sequelize.transaction(async (transaction) => {
        // name is nullable in the model; treat an empty string as "clear it".
        if (name !== undefined) trunk.name = typeof name === 'string' && name.trim() ? name.trim() : null;
        if (chargeable !== undefined) trunk.chargeable = !!chargeable;
        // provider is stored under flags.provider (the numbering provider this
        // chargeable trunk fronts, e.g. "magrathea"); reassign flags so the
        // JSONB column is marked dirty. Empty/null clears it.
        if (provider !== undefined) {
          const flags = { ...(trunk.flags || {}) };
          if (provider && provider.trim()) flags.provider = provider.trim();
          else delete flags.provider;
          trunk.flags = Object.keys(flags).length ? flags : null;
        }
        await trunk.save({ transaction });
        // setOrganisations reconciles the TrunkOrganisation join table to exactly
        // `orgs` (adds/removes rows); only touch it when the caller sent the field.
        if (orgs !== null) await trunk.setOrganisations(orgs, { transaction });
      });
      const fresh = await Trunk.findByPk(trunk.id, withOrgs);
      return res.send(project(fresh));
    } catch (err) {
      logger.error({ err: err?.message }, 'updating trunk');
      return res.status(400).send({ message: err?.message || 'Failed to update trunk' });
    }
  };
  update.apiDoc = {
    summary: 'Update a trunk: name, chargeable (billable), organisation assignments (super admin).',
    operationId: 'updateTrunk',
    tags: ['Phone Endpoints'],
    parameters: [{ in: 'path', name: 'trunkId', required: true, schema: { type: 'string' } }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string', nullable: true, description: 'Free-form human name; empty clears it' },
              chargeable: { type: 'boolean', description: 'Whether outbound minutes are destination-billed to the org' },
              provider: { type: 'string', nullable: true, description: 'Numbering provider this chargeable trunk fronts (stored under flags.provider, e.g. "magrathea"); the Buy-number flow lands a bought number on the chargeable trunk whose provider matches the carrier it was bought from. Empty/null clears it.' },
              organisationIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'The exact set of organisations this trunk is assigned to (replaces the current assignment set)',
              },
            },
            required: [],
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated trunk' },
      400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PATCH: update };
}
