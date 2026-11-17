import { applyBatch } from '../../../lib/pbx/directory.js';
import { listEntries } from '../../../lib/pbx/directory-views.js';
import { BATCH_ACTORS, MAX_BATCH_OPS } from '../../../lib/pbx/batch.js';
import { directoryContext, attempt, isKnowledgeService, mayActAsCrawl } from '../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, dryRunQuery, errorResponses, ok, body, ref } from '../../../lib/pbx/api-docs.js';

export default function (logger) {
  const post = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'update', { batch: true });
    if (!ctx) return;
    const user = res.locals.user;
    const actor = req.body?.actor ?? 'user';
    if (!Object.hasOwn(BATCH_ACTORS, actor)) {
      return res.status(400).send({ error: `actor must be one of ${Object.keys(BATCH_ACTORS).join(', ')}`, code: 'invalid_request', field: 'actor' });
    }
    if (actor === 'crawl' && !mayActAsCrawl(user)) {
      return res.status(403).send({ error: 'Only the knowledge service writes as the crawl.', code: 'actor_not_allowed', field: 'actor' });
    }
    if (actor !== 'crawl' && isKnowledgeService(user)) {
      return res.status(403).send({ error: 'This key writes as the crawl only.', code: 'crawl_only', field: 'actor' });
    }
    ctx.actor = { kind: BATCH_ACTORS[actor], userId: ctx.actor.userId };
    const result = await applyBatch(ctx, { ops: req.body?.ops });
    // Read after the commit, so the list holds what the batch wrote.
    if (!result.dryRun) result.entries = (await listEntries(ctx.organisation.id)).entries;
    res.send(result);
  });
  post.apiDoc = {
    summary: 'Apply several directory changes at once: all of them, or none.',
    description: `Up to ${MAX_BATCH_OPS} ops, applied in order in one transaction. An op may name the row it creates with \`ref\`, `
      + 'and a later op may use `"$ref"` in place of that row\'s id. The keys of each phone are worked out once, at the end. '
      + 'When an op is refused nothing is changed, and the answer is 400 `batch_failed` with a result for each op up to and including the refused one. '
      + '`actor: "crawl"` is accepted only from the knowledge service, and only for `entry.create`, `entry.update` and `extension.create` of type `connection`.',
    operationId: 'applyDirectoryBatch',
    tags: [DIRECTORY_TAG],
    parameters: [dryRunQuery, organisationIdQuery],
    requestBody: body(ref('DirectoryBatch')),
    responses: {
      200: ok('The batch was applied', {
        applied: { type: 'integer' },
        results: { type: 'array', items: ref('DirectoryBatchResult') },
        entries: { type: 'array', items: ref('DirectoryEntry'), description: 'The whole directory after the batch. Not in a dry run.' },
      }, { write: true }),
      413: { description: '`too_many_ops`', content: { 'application/json': { schema: ref('DirectoryError') } } },
      ...errorResponses,
    },
  };
  return { POST: post };
}
