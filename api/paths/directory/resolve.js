import { resolveDirectory, kindOf } from '../../../lib/directory/agent-views.js';
import { directoryContext, attempt, sendNotFound } from '../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, errorResponses, ref } from '../../../lib/pbx/api-docs.js';

const text = (value) => (typeof value === 'string' ? value.trim() : '');

export default function (logger) {
  const get = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'lookup');
    if (!ctx) return;
    const contactId = text(req.query.contact_id);
    const query = text(req.query.query);
    if (!contactId && !query) {
      return res.status(400).send({ status: 'none', error: 'contact_id or query is required', match: null, candidates: [] });
    }
    const answer = await resolveDirectory(ctx.organisation.id, { contactId: contactId || undefined, query: query || undefined, kind: kindOf(req.query.kind) });
    if (!answer) return sendNotFound(res);
    res.send(answer);
  });
  get.apiDoc = {
    summary: 'Find the one entry an agent should transfer to.',
    description: 'The answer of the agent tool `directory_resolve`. `ok` names one confident match with its numbers, for the transfer step. '
      + '`ambiguous` lists candidates for the agent to ask about. `none` means nothing came close. It never guesses.',
    operationId: 'resolveDirectory',
    tags: [DIRECTORY_TAG],
    parameters: [
      { in: 'query', name: 'query', required: false, schema: { type: 'string' }, description: 'A name, role or department, as a caller says it.' },
      { in: 'query', name: 'contact_id', required: false, schema: { type: 'string' }, description: 'The id from a lookup, in place of a query.' },
      { in: 'query', name: 'kind', required: false, schema: { type: 'string', enum: ['person', 'team', 'service'] } },
      organisationIdQuery,
    ],
    responses: { 200: { description: 'The verdict', content: { 'application/json': { schema: ref('DirectoryResolve') } } }, ...errorResponses },
  };
  return { GET: get };
}
