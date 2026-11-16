import { loadIndex } from '../../../../../lib/pbx/directory-views.js';
import { ringsNow } from '../../../../../lib/pbx/rings-now.js';
import { directoryContext, attempt, sendNotFound } from '../../../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, pathId, errorResponses, ref } from '../../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const get = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'read', { gate: true });
    if (!ctx) return;
    const at = req.query.at ? new Date(String(req.query.at)) : new Date();
    if (Number.isNaN(at.valueOf())) {
      return res.status(400).send({ error: 'at must be a date and time.', code: 'invalid_request', field: 'at' });
    }
    const index = await loadIndex(ctx.organisation.id);
    const result = index && ringsNow(index, req.params.extensionId, { at });
    if (!result) return sendNotFound(res, 'Extension not found');
    res.send(result);
  });
  get.apiDoc = {
    summary: 'What a call to this extension would ring now, phone by phone.',
    description: 'The ring plan for a call at `at` (default now), with each phone\'s line marked offline when it is not registered. '
      + 'Whether a phone is in a call is not known here, so a busy phone shows as one that rings.',
    operationId: 'getExtensionRingsNow',
    tags: [DIRECTORY_TAG],
    parameters: [
      pathId('extensionId', 'The id of the extension.'),
      { in: 'query', name: 'at', required: false, schema: { type: 'string', format: 'date-time' }, description: 'The moment to work it out for.' },
      organisationIdQuery,
    ],
    responses: { 200: { description: 'What would ring', content: { 'application/json': { schema: ref('DirectoryRingsNow') } } }, ...errorResponses },
  };
  return { GET: get };
}
