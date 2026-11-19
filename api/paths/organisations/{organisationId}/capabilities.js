import { Organisation } from '../../../../lib/database.js';
import { requirePermission, can } from '../../../../lib/auth/permissions.js';
import { targetInScope } from '../../../../lib/auth/admin-scope.js';
import { principalBrand } from '../../../../lib/brands.js';
import { validateCapabilities, CAPABILITIES, OPERATOR_ONLY_CAPABILITIES, operatorOnlyChanges, requirePhoneSystemSchema } from '../../../../lib/capabilities.js';

/**
 * PUT /api/organisations/{id}/capabilities: switch whole features on or off
 * for one organisation. Gated on `organisation:setCapabilities`, which a
 * platform operator holds for every organisation and a brand's service key
 * for the organisations of its brand.
 */
export default function (logger) {
  const put = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'setCapabilities')) return;
    const list = req.body?.capabilities;
    const problem = validateCapabilities(list);
    if (problem) return res.status(400).send({ error: problem, code: 'unknown_capability', field: 'capabilities' });
    if (!requirePhoneSystemSchema(res)) return;
    const organisation = await Organisation.findByPk(req.params.organisationId);
    if (!organisation || !targetInScope(res.locals.user, 'organisation', organisation)) return res.status(404).send({ error: 'Organisation not found', code: 'not_found' });
    const before = organisation.capabilities || [];
    const operatorOnly = operatorOnlyChanges(before, list);
    if (operatorOnly.length && !can(res.locals.user, 'system', 'manage')) {
      return res.status(403).send({
        error: `Only a platform operator can give or take: ${operatorOnly.join(', ')}. Send it as it is now.`,
        code: 'operator_only_capability',
        field: 'capabilities',
      });
    }
    // Taking a capability away deletes nothing. Its routes are refused from now on.
    await organisation.update({ capabilities: [...new Set(list)] });
    logger.info({
      audit: 'organisation-capabilities-set',
      organisationId: organisation.id,
      userId: res.locals.user?.id,
      brand: principalBrand(res.locals.user),
      before,
      after: organisation.capabilities,
    }, 'organisation capabilities set');
    return res.send({ capabilities: organisation.capabilities });
  };
  put.apiDoc = {
    summary: "Set an organisation's capabilities.",
    description: `The whole list is replaced. Known capabilities: ${CAPABILITIES.join(', ')}. Removing one deletes nothing: `
      + 'its routes answer 403 `phone_system_disabled` and reads of what exists still work for an operator. '
      + 'A platform operator may set them on any organisation, and a brand\'s service key on the organisations of its brand. '
      + `Only a platform operator may give or take ${OPERATOR_ONLY_CAPABILITIES.join(', ')}: any other caller must send it as it `
      + 'is now (403 `operator_only_capability`).',
    operationId: 'setOrganisationCapabilities',
    tags: ['Organisations'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['capabilities'],
            properties: { capabilities: { type: 'array', items: { type: 'string', enum: CAPABILITIES } } },
          },
        },
      },
    },
    responses: {
      200: { description: 'The capabilities now set', content: { 'application/json': { schema: { type: 'object', properties: { capabilities: { type: 'array', items: { type: 'string' } } } } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { PUT: put };
}
