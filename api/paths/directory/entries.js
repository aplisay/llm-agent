import { listEntries } from '../../../lib/pbx/directory-views.js';
import { createEntry } from '../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite } from '../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, dryRunQuery, errorResponses, ok, body, ref } from '../../../lib/pbx/api-docs.js';
import { can } from '../../../lib/auth/permissions.js';

export default function (logger) {
  const list = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'read');
    if (!ctx) return;
    const { kind, q } = req.query;
    // Removed entries are shown only to someone who could restore them.
    const includeDeleted = String(req.query.includeDeleted) === 'true' && can(res.locals.user, 'directory', 'update');
    res.send(await listEntries(ctx.organisation.id, { kind, q, includeDeleted }));
  });
  list.apiDoc = {
    summary: 'List the people, teams and services in the directory.',
    operationId: 'listDirectoryEntries',
    tags: [DIRECTORY_TAG],
    parameters: [
      { in: 'query', name: 'kind', schema: { type: 'string', enum: ['person', 'team', 'service'] } },
      { in: 'query', name: 'q', schema: { type: 'string' }, description: 'Part of a name.' },
      { in: 'query', name: 'includeDeleted', schema: { type: 'boolean' }, description: 'Also list removed entries. Needs directory:update.' },
      organisationIdQuery,
    ],
    responses: {
      200: ok('The entries', {
        entries: { type: 'array', items: ref('DirectoryEntry') },
        departments: { type: 'array', items: { type: 'string' }, description: 'Departments in use, most used first.' },
        meta: { type: 'object', properties: { total: { type: 'integer' }, lastChangeAt: { type: 'string', format: 'date-time', nullable: true } } },
      }),
      ...errorResponses,
    },
  };

  const create = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update');
    if (!ctx) return;
    sendWrite(res, await createEntry(ctx, req.body || {}), 201);
  });
  create.apiDoc = {
    summary: 'Add a person, team or service to the directory.',
    description: 'With `extension`, the entry is given an extension of type `extensionType` (default `connection`). '
      + 'Any other type needs the phone system.',
    operationId: 'createDirectoryEntry',
    tags: [DIRECTORY_TAG],
    parameters: [dryRunQuery, organisationIdQuery],
    requestBody: body(ref('DirectoryEntryInput')),
    responses: { 201: ok('The new entry', { entry: ref('DirectoryEntry') }, { write: true }), 200: ok('The dry run', {}, { write: true }), ...errorResponses },
  };

  return { GET: list, POST: create };
}
