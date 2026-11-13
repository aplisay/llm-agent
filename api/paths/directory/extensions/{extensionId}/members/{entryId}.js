import { removeMember } from '../../../../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite } from '../../../../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, dryRunQuery, pathId, errorResponses, ok } from '../../../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const remove = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update', { gate: true });
    if (!ctx) return;
    sendWrite(res, await removeMember(ctx, req.params.extensionId, req.params.entryId));
  });
  remove.apiDoc = {
    summary: 'Take a person off an extension.',
    description: "The extension's line goes from the person's phones. The owner of their own extension cannot be removed (`owner_not_removable`).",
    operationId: 'removeDirectoryExtensionMember',
    tags: [DIRECTORY_TAG],
    parameters: [
      pathId('extensionId', 'The id of the extension.'),
      pathId('entryId', 'The id of the person.'),
      dryRunQuery,
      organisationIdQuery,
    ],
    responses: { 200: ok('Removed', {}, { write: true }), ...errorResponses },
  };
  return { DELETE: remove };
}
