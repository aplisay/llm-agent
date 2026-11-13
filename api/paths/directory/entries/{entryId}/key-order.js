import { setKeyOrder } from '../../../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite } from '../../../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, dryRunQuery, pathId, errorResponses, ok, body } from '../../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const put = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update', { gate: true });
    if (!ctx) return;
    sendWrite(res, await setKeyOrder(ctx, req.params.entryId, req.body?.extensionIds));
  });
  put.apiDoc = {
    summary: "Set the order of a person's shared extensions on their phones.",
    description: "The list must hold every shared extension the person belongs to, once each. The person's own extension always comes first and is not listed.",
    operationId: 'setDirectoryEntryKeyOrder',
    tags: [DIRECTORY_TAG],
    parameters: [pathId('entryId', 'The id of the person.'), dryRunQuery, organisationIdQuery],
    requestBody: body({
      type: 'object',
      required: ['extensionIds'],
      properties: { extensionIds: { type: 'array', items: { type: 'string', format: 'uuid' } } },
    }),
    responses: {
      200: ok('The memberships in their new order', { memberships: { type: 'array', items: { type: 'object' } } }, { write: true }),
      ...errorResponses,
    },
  };
  return { PUT: put };
}
