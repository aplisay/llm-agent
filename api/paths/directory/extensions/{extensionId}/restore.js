import { restoreExtension } from '../../../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite } from '../../../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, dryRunQuery, pathId, errorResponses, ok, ref } from '../../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const post = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update');
    if (!ctx) return;
    sendWrite(res, await restoreExtension(ctx, req.params.extensionId));
  });
  post.apiDoc = {
    summary: 'Bring back a removed extension.',
    description: 'Its members come back with it. Refused with `extension_number_taken` when its number is in use again, '
      + '`entry_has_extension` when its entry has another extension, and `entry_removed` when its entry is removed.',
    operationId: 'restoreDirectoryExtension',
    tags: [DIRECTORY_TAG],
    parameters: [pathId('extensionId', 'The id of the removed extension.'), dryRunQuery, organisationIdQuery],
    responses: { 200: ok('The extension', { extension: ref('DirectoryExtension') }, { write: true }), ...errorResponses },
  };
  return { POST: post };
}
