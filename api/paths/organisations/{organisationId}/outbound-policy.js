import { Organisation } from '../../../../lib/database.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { targetInScope } from '../../../../lib/auth/admin-scope.js';
import { requirePhoneSystem } from '../../../../lib/capabilities.js';
import {
  mergePolicy, aboveCeiling, effectivePolicy, periodsAt, outboundPolicyReady, DEFAULT_TIME_ZONE, POLICY_CODES,
} from '../../../../lib/outbound-policy.js';
import { brandCeiling, outboundUsage, outboundNotices } from '../../../../lib/outbound-authorisation.js';
import { forgetOutboundNow } from '../../../../lib/outbound-now.js';

const NOT_READY = {
  error: 'The outbound policy needs a database upgrade. Run tools/agent-admin.js upgrade-db, then restart the API server.',
  code: POLICY_CODES.notReady,
};

const errorResponse = { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const pathParameter = { in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } };

/**
 * /api/organisations/{id}/outbound-policy: the limits on the organisation's
 * outside calls (lib/outbound-policy.js). An organisation's owner or admin
 * acts on their own organisation, within the ceiling of its brand. A platform
 * operator acts on any. Needs the phone system.
 */
export default function (logger) {
  const load = async (req, res, action) => {
    if (!requirePermission(res, 'organisation', action)) return null;
    const organisation = await Organisation.findByPk(req.params.organisationId);
    // 404 for another organisation too, so its existence is not confirmed.
    if (!organisation || !targetInScope(res.locals.user, 'organisation', organisation)) {
      res.status(404).send({ error: 'Organisation not found', code: 'not_found' });
      return null;
    }
    if (!requirePhoneSystem(res, organisation)) return null;
    if (!outboundPolicyReady()) {
      res.status(503).send(NOT_READY);
      return null;
    }
    return organisation;
  };

  const shape = async (organisation, ceiling) => {
    const policy = organisation.outboundPolicy && typeof organisation.outboundPolicy === 'object' ? organisation.outboundPolicy : {};
    const effective = effectivePolicy(policy, ceiling);
    const timeZone = effective.hours?.timeZone || DEFAULT_TIME_ZONE;
    const now = new Date();
    const usage = await outboundUsage({ organisationId: organisation.id, at: now, timeZone });
    const { dayStart } = periodsAt(now, timeZone);
    const { hoursUnusable, ...applied } = effective;
    return {
      policy,
      ceiling,
      // A stored hours rule that no longer checks refuses every call, so it is shown as stored, not as "any time".
      effective: { ...applied, hours: hoursUnusable ? policy.hours : applied.hours, hoursValid: !hoursUnusable },
      usage: {
        callsInProgress: usage.callsInProgress,
        callsLastMinute: usage.callsLastMinute,
        spendTodayMicros: usage.spendToday,
        spendMonthMicros: usage.spendMonth,
      },
      notices: await outboundNotices({ organisationId: organisation.id, since: dayStart }),
    };
  };

  const get = async (req, res) => {
    try {
      const organisation = await load(req, res, 'read');
      if (!organisation) return;
      return res.send(await shape(organisation, await brandCeiling(organisation.brand)));
    } catch (err) {
      req.log.error(err, 'error reading an outbound policy');
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
  get.apiDoc = {
    summary: "Read an organisation's outbound policy, its brand's ceiling, what applies, and today's use.",
    operationId: 'getOrganisationOutboundPolicy',
    tags: ['Organisations'],
    parameters: [pathParameter],
    responses: {
      200: { description: 'The policy', content: { 'application/json': { schema: { $ref: '#/components/schemas/OrganisationOutboundPolicy' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      503: { description: 'The outbound policy needs a database upgrade (`outbound_policy_not_ready`)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: errorResponse,
    },
  };

  const put = async (req, res) => {
    try {
      const organisation = await load(req, res, 'update');
      if (!organisation) return;
      const change = req.body;
      const firstCheck = mergePolicy(organisation.outboundPolicy, change);
      if (firstCheck.error) return res.status(400).send({ error: firstCheck.error, code: 'invalid_request', field: firstCheck.field });
      // Only what this change opens or raises is held to the ceiling, so a lowered
      // ceiling does not block an unrelated change. effectivePolicy clips the rest.
      const ceiling = await brandCeiling(organisation.brand);
      const over = aboveCeiling(change, ceiling);
      if (over) return res.status(400).send({ error: over.error, code: 'above_ceiling', field: over.field });
      // Merge onto the row as it is under a lock, so two changes at once both stick.
      await Organisation.sequelize.transaction(async (transaction) => {
        const row = await Organisation.findByPk(organisation.id, {
          attributes: ['id', 'outboundPolicy'], transaction, lock: transaction.LOCK.UPDATE,
        });
        const { policy } = mergePolicy(row.outboundPolicy, change);
        await row.update({ outboundPolicy: policy }, { transaction });
        organisation.outboundPolicy = policy;
      });
      forgetOutboundNow(organisation.id);
      logger.info({
        audit: 'organisation-outbound-policy-set',
        organisationId: organisation.id,
        userId: res.locals.user?.id,
        fields: Object.keys(change),
      }, 'organisation outbound policy changed');
      return res.send(await shape(organisation, ceiling));
    } catch (err) {
      req.log.error(err, 'error setting an outbound policy');
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
  put.apiDoc = {
    summary: "Change an organisation's outbound policy.",
    description: 'Send only the fields to change. A class not named keeps its value. A limit set to null goes back to the '
      + "brand's ceiling, and `hours` set to null removes the hours rule. A value wider than the ceiling is refused with "
      + '`above_ceiling`. The policy applies to outside calls on the platform\'s own trunks.',
    operationId: 'setOrganisationOutboundPolicy',
    tags: ['Organisations'],
    parameters: [pathParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/OutboundPolicy' } } },
    },
    responses: {
      200: { description: 'The policy after the change', content: { 'application/json': { schema: { $ref: '#/components/schemas/OrganisationOutboundPolicy' } } } },
      400: { description: 'A field that cannot be stored (`invalid_request`) or is wider than the ceiling (`above_ceiling`)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      503: { description: 'The outbound policy needs a database upgrade (`outbound_policy_not_ready`)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: errorResponse,
    },
  };

  return { GET: get, PUT: put };
}
