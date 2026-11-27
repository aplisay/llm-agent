import { Organisation } from '../../../../../lib/database.js';
import { requirePermission } from '../../../../../lib/auth/permissions.js';
import { targetInScope } from '../../../../../lib/auth/admin-scope.js';
import { requirePhoneSystem } from '../../../../../lib/capabilities.js';
import { outboundPolicyReady, POLICY_CODES } from '../../../../../lib/outbound-policy.js';
import { cachedOutboundNow, NOW_CACHE_MS } from '../../../../../lib/outbound-now.js';

const NOT_READY = {
  error: 'The outbound policy needs a database upgrade. Run tools/agent-admin.js upgrade-db, then restart the API server.',
  code: POLICY_CODES.notReady,
};

/**
 * /api/organisations/{id}/outbound-policy/now: would an outside call be refused
 * at this moment, and why (lib/outbound-now.js). Read as the policy is read.
 */
export default function (logger) {
  const get = async (req, res) => {
    try {
      if (!requirePermission(res, 'organisation', 'read')) return;
      const organisation = await Organisation.findByPk(req.params.organisationId);
      // 404 for another organisation too, so its existence is not confirmed.
      if (!organisation || !targetInScope(res.locals.user, 'organisation', organisation)) {
        return res.status(404).send({ error: 'Organisation not found', code: 'not_found' });
      }
      if (!requirePhoneSystem(res, organisation)) return;
      if (!outboundPolicyReady()) return res.status(503).send(NOT_READY);
      res.set('Cache-Control', `private, max-age=${NOW_CACHE_MS / 1000}`);
      return res.send(await cachedOutboundNow(organisation));
    } catch (err) {
      (req.log || logger).error(err, 'error reading whether outside calls are blocked');
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
  get.apiDoc = {
    summary: 'Would an outside call be refused at this moment, and why.',
    description: 'For a banner. Lists every reason that would refuse any outside call now, whatever number is dialled: '
      + 'the organisation deactivated or its charge unpaid, an empty balance, outside the hours rule, a spend limit reached, '
      + 'or the calls at once or calls a minute limit reached. A number of a class the policy closes is refused too, and is '
      + `not listed here. The answer may be up to ${NOW_CACHE_MS / 1000} seconds old.`,
    operationId: 'getOrganisationOutboundNow',
    tags: ['Organisations'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Whether outside calls are blocked now', content: { 'application/json': { schema: { $ref: '#/components/schemas/OutboundNow' } } } },
      403: { description: 'No permission, or the organisation has no phone system (`phone_system_disabled`)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      503: { description: 'The outbound policy needs a database upgrade (`outbound_policy_not_ready`)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get };
}
