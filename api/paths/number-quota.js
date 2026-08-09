import { PhoneNumber, Trunk, Organisation, Op } from '../../lib/database.js';
import { requirePermission } from '../../lib/auth/permissions.js';

/**
 * /api/number-quota — the caller's organisation allowance for phone numbers on
 * chargeable (non-owned) trunks. `Organisation.chargeableNumberLimit` caps how
 * many DDIs an org may hold on carrier trunks the platform pays for; numbers on
 * the org's own (chargeable=false) trunks never count. Backs the dashboard
 * "Buy number" flow so it can show remaining allowance before a purchase; the
 * hard enforcement lives in createPhoneEndpoint.
 */
export default function (logger) {
  const getQuota = async (req, res) => {
    if (!requirePermission(res, 'phoneEndpoint', 'read')) return;
    const { organisationId } = res.locals.user || {};
    if (!organisationId) {
      return res.status(403).send({ error: 'Requires an organisation membership' });
    }
    try {
      const org = await Organisation.findByPk(organisationId, {
        attributes: ['id', 'chargeableNumberLimit'],
      });
      if (!org) {
        return res.status(404).send({ error: 'Organisation not found' });
      }
      const chargeableTrunks = await Trunk.findAll({
        where: { chargeable: true },
        attributes: ['id'],
      });
      const used = chargeableTrunks.length
        ? await PhoneNumber.count({
            where: {
              organisationId,
              aplisayId: { [Op.in]: chargeableTrunks.map((t) => t.id) },
            },
          })
        : 0;
      const limit = org.chargeableNumberLimit ?? null;
      return res.send({
        limit,
        used,
        remaining: limit == null ? null : Math.max(0, limit - used),
      });
    } catch (err) {
      req.log?.error(err, 'fetching number quota');
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
  getQuota.apiDoc = {
    summary: "The caller's organisation quota for numbers on chargeable (non-owned) trunks.",
    description: `Returns the organisation's chargeable number limit, how many numbers it
                  currently holds on chargeable trunks, and the remaining allowance.
                  A null limit means unlimited (remaining is null). Numbers on trunks the
                  organisation owns (chargeable=false) are not counted.`,
    operationId: 'getNumberQuota',
    tags: ['Phone Endpoints'],
    responses: {
      200: {
        description: 'The organisation number quota',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['limit', 'used', 'remaining'],
              properties: {
                limit: { type: 'integer', nullable: true, description: 'Max numbers on chargeable trunks; null = unlimited' },
                used: { type: 'integer', description: 'Numbers currently held on chargeable trunks' },
                remaining: { type: 'integer', nullable: true, description: 'Numbers still purchasable; null when unlimited' },
              },
            },
          },
        },
      },
      default: {
        description: 'An error occurred',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  };
  return { GET: getQuota };
}
