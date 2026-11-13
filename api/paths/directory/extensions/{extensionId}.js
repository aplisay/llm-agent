import { getExtension } from '../../../../lib/pbx/directory-views.js';
import { updateExtension, deleteExtension } from '../../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite, sendNotFound } from '../../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, dryRunQuery, pathId, errorResponses, ok, body, ref } from '../../../../lib/pbx/api-docs.js';

const extensionId = pathId('extensionId', 'The id of the extension.');

export default function (logger) {
  const get = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'read');
    if (!ctx) return;
    const extension = await getExtension(ctx.organisation.id, req.params.extensionId);
    if (!extension) return sendNotFound(res, 'Extension not found');
    res.send(extension);
  });
  get.apiDoc = {
    summary: 'Read one extension.',
    operationId: 'getDirectoryExtension',
    tags: [DIRECTORY_TAG],
    parameters: [extensionId, organisationIdQuery],
    responses: { 200: { description: 'The extension', content: { 'application/json': { schema: ref('DirectoryExtension') } } }, ...errorResponses },
  };

  const patch = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update');
    if (!ctx) return;
    sendWrite(res, await updateExtension(ctx, req.params.extensionId, req.body || {}));
  });
  patch.apiDoc = {
    summary: 'Change an extension.',
    description: 'Send only the fields to change. `params` is merged one level deep, and a key set to null is removed. '
      + 'A change to a type that has no members is refused with `extension_has_members` while it has any.',
    operationId: 'updateDirectoryExtension',
    tags: [DIRECTORY_TAG],
    parameters: [extensionId, dryRunQuery, organisationIdQuery],
    requestBody: body(ref('DirectoryExtensionInput')),
    responses: { 200: ok('The extension after the change', { extension: ref('DirectoryExtension') }, { write: true }), ...errorResponses },
  };

  const remove = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update');
    if (!ctx) return;
    sendWrite(res, await deleteExtension(ctx, req.params.extensionId));
  });
  remove.apiDoc = {
    summary: 'Remove an extension.',
    description: 'Refused while a number rings it (`extension_has_numbers`) or another extension sends calls to it '
      + '(`extension_is_destination`). Its members lose its line on their phones.',
    operationId: 'deleteDirectoryExtension',
    tags: [DIRECTORY_TAG],
    parameters: [extensionId, dryRunQuery, organisationIdQuery],
    responses: { 200: ok('Removed', {}, { write: true }), ...errorResponses },
  };

  return { GET: get, PATCH: patch, DELETE: remove };
}
