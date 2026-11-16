import { loadIndex } from '../../../../lib/pbx/directory-views.js';
import { nextExtensionNumber } from '../../../../lib/pbx/next-number.js';
import { directoryContext, attempt, sendNotFound } from '../../../../lib/pbx/route-helpers.js';
import { DIRECTORY_TAG, organisationIdQuery, errorResponses, ok } from '../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const get = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'directory', 'read');
    if (!ctx) return;
    const index = await loadIndex(ctx.organisation.id);
    if (!index) return sendNotFound(res);
    const numbers = [...index.extensions.values()].map((extension) => extension.number);
    res.send({ number: nextExtensionNumber(numbers, req.query.near) });
  });
  get.apiDoc = {
    summary: 'The number to offer for a new extension.',
    description: 'The lowest free number with as many digits as `near`, or as most of the organisation\'s extensions have '
      + '(3 when it has none). It never starts with 0 and is never 999, 112 or 911 or a number that begins with one. '
      + '`number` is null when every number of that length is taken.',
    operationId: 'getNextExtensionNumber',
    tags: [DIRECTORY_TAG],
    parameters: [
      { in: 'query', name: 'near', required: false, schema: { type: 'string', pattern: '^[0-9]{1,8}$' }, description: 'Digits whose length to match.' },
      organisationIdQuery,
    ],
    responses: { 200: ok('The number', { number: { type: 'string', nullable: true } }), ...errorResponses },
  };
  return { GET: get };
}
