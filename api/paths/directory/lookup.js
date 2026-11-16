import { lookupDirectory, kindOf } from '../../../lib/directory/agent-views.js';
import { directoryContext, attempt, sendNotFound } from '../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, errorResponses, ref } from '../../../lib/pbx/api-docs.js';

export default function (logger) {
  const get = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'lookup');
    if (!ctx) return;
    const answer = await lookupDirectory(ctx.organisation.id, {
      query: typeof req.query.query === 'string' ? req.query.query : '',
      kind: kindOf(req.query.kind),
      limit: req.query.limit,
    });
    if (!answer) return sendNotFound(res);
    res.send(answer);
  });
  get.apiDoc = {
    summary: 'Search the directory as an agent sees it.',
    description: 'The answer of the agent tool `directory_lookup`. A person\'s numbers and every email address are left out. '
      + 'A team or service shows its numbers only when it says to. With no query, the first entries by name.',
    operationId: 'lookupDirectory',
    tags: [DIRECTORY_TAG],
    parameters: [
      { in: 'query', name: 'query', required: false, schema: { type: 'string' }, description: 'A name, role, department or topic, as a caller says it.' },
      { in: 'query', name: 'kind', required: false, schema: { type: 'string', enum: ['person', 'team', 'service'] } },
      { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 8 } },
      organisationIdQuery,
    ],
    responses: { 200: { description: 'The matches, best first', content: { 'application/json': { schema: ref('DirectoryLookup') } } }, ...errorResponses },
  };
  return { GET: get };
}
