import { getExtension } from '../../../../../lib/pbx/directory-views.js';
import { addMember, setMembers } from '../../../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite, sendNotFound } from '../../../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, dryRunQuery, pathId, errorResponses, ok, body, ref } from '../../../../../lib/pbx/api-docs.js';

const extensionId = pathId('extensionId', 'The id of the extension.');
const members = { type: 'array', items: ref('DirectoryExtensionMember') };

export default function (logger) {
  const list = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'read', { gate: true });
    if (!ctx) return;
    const extension = await getExtension(ctx.organisation.id, req.params.extensionId);
    if (!extension) return sendNotFound(res, 'Extension not found');
    res.send({ members: extension.members });
  });
  list.apiDoc = {
    summary: 'List the members of an extension, in hunt order.',
    operationId: 'listDirectoryExtensionMembers',
    tags: [DIRECTORY_TAG],
    parameters: [extensionId, organisationIdQuery],
    responses: { 200: ok('The members', { members }), ...errorResponses },
  };

  const add = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update', { gate: true });
    if (!ctx) return;
    sendWrite(res, await addMember(ctx, req.params.extensionId, req.body || {}), 201);
  });
  add.apiDoc = {
    summary: 'Add a person to an extension.',
    description: "The extension gets a line on every phone that rings for the person. Without positions the person is last "
      + "in the extension's hunt order and the extension is last among the person's shared keys.",
    operationId: 'addDirectoryExtensionMember',
    tags: [DIRECTORY_TAG],
    parameters: [extensionId, dryRunQuery, organisationIdQuery],
    requestBody: body({
      type: 'object',
      required: ['entryId'],
      properties: {
        entryId: { type: 'string', format: 'uuid' },
        huntPosition: { type: 'integer', minimum: 1 },
        keyPosition: { type: 'integer', minimum: 1 },
      },
    }),
    responses: { 201: ok('The new member', { member: ref('DirectoryExtensionMember') }, { write: true }), 200: ok('The dry run', {}, { write: true }), ...errorResponses },
  };

  const put = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update', { gate: true });
    if (!ctx) return;
    sendWrite(res, await setMembers(ctx, req.params.extensionId, req.body?.entryIds));
  });
  put.apiDoc = {
    summary: 'Set the whole member list of an extension, in hunt order.',
    description: "People not in the list are removed. New people get the extension last among their shared keys. The owner of a person's own extension must be in the list.",
    operationId: 'setDirectoryExtensionMembers',
    tags: [DIRECTORY_TAG],
    parameters: [extensionId, dryRunQuery, organisationIdQuery],
    requestBody: body({
      type: 'object',
      required: ['entryIds'],
      properties: { entryIds: { type: 'array', items: { type: 'string', format: 'uuid' } } },
    }),
    responses: { 200: ok('The members', { members }, { write: true }), ...errorResponses },
  };

  return { GET: list, POST: add, PUT: put };
}
