import { Organisation } from '../../../../lib/database.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { validateCapabilities, CAPABILITIES } from '../../../../lib/capabilities.js';

/**
 * PUT /api/organisations/{id}/capabilities: switch whole features on or off
 * for one organisation. Gated on `organisation:setCapabilities`, which only a
 * platform operator holds, so there is no tenancy scoping.
 */
export default function (logger) {
  const put = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'setCapabilities')) return;
    const list = req.body?.capabilities;
    const problem = validateCapabilities(list);
    if (problem) return res.status(400).send({ error: problem, code: 'unknown_capability', field: 'capabilities' });
    const organisation = await Organisation.findByPk(req.params.organisationId);
    if (!organisation) return res.status(404).send({ error: 'Organisation not found', code: 'not_found' });
    const before = organisation.capabilities || [];
    // Taking a capability away deletes nothing. Its routes are refused from now on.
    await organisation.update({ capabilities: [...new Set(list)] });
    logger.info({
      audit: 'organisation-capabilities-set',
      organisationId: organisation.id,
      userId: res.locals.user?.id,
      before,
      after: organisation.capabilities,
    }, 'organisation capabilities set');
    return res.send({ capabilities: organisation.capabilities });
  };
  put.apiDoc = {
    summary: "Set an organisation's capabilities.",
    description: `The whole list is replaced. Known capabilities: ${CAPABILITIES.join(', ')}. Removing one deletes nothing: `
      + 'its routes answer 403 `phone_system_disabled` and reads of what exists still work for an operator.',
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
