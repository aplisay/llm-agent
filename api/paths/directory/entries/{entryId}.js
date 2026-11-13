import { getEntry } from '../../../../lib/pbx/directory-views.js';
import { updateEntry, deleteEntry } from '../../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite, sendNotFound } from '../../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, dryRunQuery, pathId, errorResponses, ok, body, ref } from '../../../../lib/pbx/api-docs.js';

const entryId = pathId('entryId', 'The id of the entry.');

export default function (logger) {
  const get = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'read');
    if (!ctx) return;
    const entry = await getEntry(ctx.organisation.id, req.params.entryId);
    if (!entry) return sendNotFound(res, 'Entry not found');
    res.send(entry);
  });
  get.apiDoc = {
    summary: 'Read one directory entry.',
    operationId: 'getDirectoryEntry',
    tags: [DIRECTORY_TAG],
    parameters: [entryId, organisationIdQuery],
    responses: { 200: { description: 'The entry', content: { 'application/json': { schema: ref('DirectoryEntry') } } }, ...errorResponses },
  };

  const patch = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update');
    if (!ctx) return;
    sendWrite(res, await updateEntry(ctx, req.params.entryId, req.body || {}));
  });
  patch.apiDoc = {
    summary: 'Change a directory entry.',
    description: 'Send only the fields to change. `notes` is merged one level deep, and a key set to null is removed. '
      + '`extension` set to digits gives the entry an extension or renumbers the one it has. `extension: null` removes it.',
    operationId: 'updateDirectoryEntry',
    tags: [DIRECTORY_TAG],
    parameters: [entryId, dryRunQuery, organisationIdQuery],
    requestBody: body(ref('DirectoryEntryInput')),
    responses: { 200: ok('The entry after the change', { entry: ref('DirectoryEntry') }, { write: true }), ...errorResponses },
  };

  const remove = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update');
    if (!ctx) return;
    sendWrite(res, await deleteEntry(ctx, req.params.entryId));
  });
  remove.apiDoc = {
    summary: 'Remove a directory entry.',
    description: 'The entry and its extension are removed together. A person whose own extension has other members or a '
      + 'number is refused with `owned_extension_in_use`.',
    operationId: 'deleteDirectoryEntry',
    tags: [DIRECTORY_TAG],
    parameters: [entryId, dryRunQuery, organisationIdQuery],
    responses: { 200: ok('Removed', {}, { write: true }), ...errorResponses },
  };

  return { GET: get, PATCH: patch, DELETE: remove };
}
