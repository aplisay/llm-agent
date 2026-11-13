import { listExtensions } from '../../../lib/pbx/directory-views.js';
import { createExtension } from '../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite } from '../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, dryRunQuery, errorResponses, ok, body, ref } from '../../../lib/pbx/api-docs.js';

export default function (logger) {
  const list = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'read');
    if (!ctx) return;
    const personal = req.query.personal === undefined ? undefined : String(req.query.personal) === 'true';
    res.send({ extensions: await listExtensions(ctx.organisation.id, { type: req.query.type, personal }) });
  });
  list.apiDoc = {
    summary: 'List the extensions of the directory.',
    operationId: 'listDirectoryExtensions',
    tags: [DIRECTORY_TAG],
    parameters: [
      { in: 'query', name: 'type', schema: { type: 'string' } },
      { in: 'query', name: 'personal', schema: { type: 'boolean' }, description: "Only people's own extensions (true) or only shared ones (false)." },
      organisationIdQuery,
    ],
    responses: { 200: ok('The extensions', { extensions: { type: 'array', items: ref('DirectoryExtension') } }), ...errorResponses },
  };

  const create = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update');
    if (!ctx) return;
    sendWrite(res, await createExtension(ctx, req.body || {}), 201);
  });
  create.apiDoc = {
    summary: 'Give an entry an extension.',
    description: 'A type other than `connection` needs the phone system. An extension on a person is their own extension, '
      + 'and they become its owner.',
    operationId: 'createDirectoryExtension',
    tags: [DIRECTORY_TAG],
    parameters: [dryRunQuery, organisationIdQuery],
    requestBody: body(ref('DirectoryExtensionInput')),
    responses: { 201: ok('The new extension', { extension: ref('DirectoryExtension') }, { write: true }), 200: ok('The dry run', {}, { write: true }), ...errorResponses },
  };

  return { GET: list, POST: create };
}
