import { getPhone } from '../../../lib/pbx/directory-views.js';
import { updatePhone, deletePhone } from '../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite, sendNotFound } from '../../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, dryRunQuery, pathId, errorResponses, ok, body, ref } from '../../../lib/pbx/api-docs.js';

const phoneId = pathId('phoneId', 'The id of the phone.');

export default function (logger) {
  const get = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'read', { gate: true });
    if (!ctx) return;
    const phone = await getPhone(ctx.organisation.id, req.params.phoneId);
    if (!phone) return sendNotFound(res, 'Phone not found');
    res.send(phone);
  });
  get.apiDoc = {
    summary: 'Read one phone, with its people and lines.',
    operationId: 'getPhone',
    tags: [PHONES_TAG],
    parameters: [phoneId, organisationIdQuery],
    responses: { 200: { description: 'The phone', content: { 'application/json': { schema: ref('Phone') } } }, ...errorResponses },
  };

  const patch = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'update', { gate: true });
    if (!ctx) return;
    sendWrite(res, await updatePhone(ctx, req.params.phoneId, req.body || {}));
  });
  patch.apiDoc = {
    summary: 'Change a phone.',
    description: 'Any phone: `label`. An outside number: `number`, `ringDelay`, `shows`, `keyToAnswer`. A desk phone: '
      + '`model`, until the phone has reported its own model (`phone_model_reported`).',
    operationId: 'updatePhone',
    tags: [PHONES_TAG],
    parameters: [phoneId, dryRunQuery, organisationIdQuery],
    requestBody: body(ref('PhoneInput')),
    responses: { 200: ok('The phone after the change', { phone: ref('Phone') }, { write: true }), ...errorResponses },
  };

  const remove = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'delete', { gate: true });
    if (!ctx) return;
    sendWrite(res, await deletePhone(ctx, req.params.phoneId));
  });
  remove.apiDoc = {
    summary: 'Remove a phone.',
    description: 'Its lines and their SIP accounts are removed at once. The same organisation can add the phone again.',
    operationId: 'deletePhone',
    tags: [PHONES_TAG],
    parameters: [phoneId, dryRunQuery, organisationIdQuery],
    responses: { 200: ok('Removed', {}, { write: true }), ...errorResponses },
  };

  return { GET: get, PATCH: patch, DELETE: remove };
}
