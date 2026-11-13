import { listPhones } from '../../lib/pbx/directory-views.js';
import { createPhone } from '../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite } from '../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, dryRunQuery, errorResponses, ok, body, ref } from '../../lib/pbx/api-docs.js';

export default function (logger) {
  const list = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'read', { gate: true });
    if (!ctx) return;
    res.send({ phones: await listPhones(ctx.organisation.id, { kind: req.query.kind, entryId: req.query.entryId }) });
  });
  list.apiDoc = {
    summary: 'List the phones of the phone system.',
    operationId: 'listPhones',
    tags: [PHONES_TAG],
    parameters: [
      { in: 'query', name: 'kind', schema: { type: 'string', enum: ['deskphone', 'external'] } },
      { in: 'query', name: 'entryId', schema: { type: 'string', format: 'uuid' }, description: 'Only phones that ring for this person.' },
      organisationIdQuery,
    ],
    responses: { 200: ok('The phones', { phones: { type: 'array', items: ref('Phone') } }), ...errorResponses },
  };

  const create = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'create', { gate: true });
    if (!ctx) return;
    sendWrite(res, await createPhone(ctx, req.body || {}), 201);
  });
  create.apiDoc = {
    summary: 'Add a phone.',
    description: 'A desk phone (`deskphone`) is named by its MAC address and model. An outside number such as a mobile '
      + '(`external`) rings for one person, for their own extension only. The lines of a desk phone are worked out from '
      + 'the people it rings for and are never set by hand. With `dryRun=true` the answer is the lines the phone would get.',
    operationId: 'createPhone',
    tags: [PHONES_TAG],
    parameters: [dryRunQuery, organisationIdQuery],
    requestBody: body(ref('PhoneInput')),
    responses: { 201: ok('The new phone', { phone: ref('Phone') }, { write: true }), 200: ok('The dry run', {}, { write: true }), ...errorResponses },
  };

  return { GET: list, POST: create };
}
