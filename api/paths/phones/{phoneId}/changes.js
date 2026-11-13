import { listChanges } from '../../../../lib/pbx/directory-views.js';
import { directoryContext, attempt, sendNotFound } from '../../../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, pathId, errorResponses, ok } from '../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const list = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'read', { gate: true });
    if (!ctx) return;
    const changes = await listChanges(ctx.organisation.id, req.params.phoneId, { limit: req.query.limit, before: req.query.before });
    if (!changes) return sendNotFound(res, 'Phone not found');
    res.send({ changes });
  });
  list.apiDoc = {
    summary: "The record of why a phone's keys changed, newest first.",
    operationId: 'listPhoneChanges',
    tags: [PHONES_TAG],
    parameters: [
      pathId('phoneId', 'The id of the phone.'),
      { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      { in: 'query', name: 'before', schema: { type: 'string', format: 'date-time' }, description: 'Only changes before this time.' },
      organisationIdQuery,
    ],
    responses: { 200: ok('The changes', { changes: { type: 'array', items: { type: 'object' } } }), ...errorResponses },
  };
  return { GET: list };
}
