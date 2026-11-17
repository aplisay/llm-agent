import { restoreEntry } from '../../../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite } from '../../../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, dryRunQuery, pathId, errorResponses, ok, ref } from '../../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const post = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update');
    if (!ctx) return;
    sendWrite(res, await restoreEntry(ctx, req.params.entryId));
  });
  post.apiDoc = {
    summary: 'Bring back a removed directory entry.',
    description: 'The extension removed with the entry comes back too, and so do its memberships and phones. '
      + 'A removed entry can be restored for 30 days. A login linked since to someone else, or no longer in the organisation, is not linked again.',
    operationId: 'restoreDirectoryEntry',
    tags: [DIRECTORY_TAG],
    parameters: [pathId('entryId', 'The id of the removed entry.'), dryRunQuery, organisationIdQuery],
    responses: { 200: ok('The entry', { entry: ref('DirectoryEntry') }, { write: true }), ...errorResponses },
  };
  return { POST: post };
}
