import { getPhone } from '../../../../lib/pbx/directory-views.js';
import { directoryContext, attempt, sendNotFound } from '../../../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, pathId, errorResponses, ok, ref } from '../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const list = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'read', { gate: true });
    if (!ctx) return;
    const phone = await getPhone(ctx.organisation.id, req.params.phoneId);
    if (!phone) return sendNotFound(res, 'Phone not found');
    res.send({ lines: phone.lines });
  });
  list.apiDoc = {
    summary: 'List the lines the system has worked out for a phone.',
    description: 'Read only. A line is one key on the phone: an extension, or the overflow line that takes calls for every extension that did not fit.',
    operationId: 'listPhoneLines',
    tags: [PHONES_TAG],
    parameters: [pathId('phoneId', 'The id of the phone.'), organisationIdQuery],
    responses: { 200: ok('The lines, in key order', { lines: { type: 'array', items: ref('PhoneLine') } }), ...errorResponses },
  };
  return { GET: list };
}
