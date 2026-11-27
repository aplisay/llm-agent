import { listLines, DEFAULT_PAGE, MAX_PAGE } from '../../../../lib/pbx/line-list.js';
import { sendPbxError } from '../../../../lib/pbx/errors.js';

/**
 * GET /api/agent-db/pbx/lines: every desk phone line with the `from` and
 * `caller` blocks of a plan for a call from it. Internal. It takes the call
 * control token (x-callctl-token) only: see middleware/auth.js.
 *
 * Call control reads it at start and every few minutes, so that it knows the
 * number each line shows before that line's first call (docs/phone-system.md).
 */
export default function (logger) {
  const list = async (req, res) => {
    try {
      // As it was sent: the query parser rounds a fraction down before this runs.
      const sent = new URL(req.originalUrl, 'http://localhost').searchParams;
      const limit = sent.get('limit');
      res.send(await listLines({
        after: sent.get('after') ?? '',
        limit: limit === null || limit === '' ? DEFAULT_PAGE : (/^\d+$/.test(limit) ? Number(limit) : NaN),
      }));
    } catch (err) {
      sendPbxError(res, err, logger, 'error listing phone system lines');
    }
  };
  const nullable = (type) => ({ type, nullable: true });
  list.apiDoc = {
    summary: 'List every desk phone line with the number it shows (internal).',
    description: 'A page holds every line of each of `limit` organisations. Follow `next` until it is null. '
      + '`from` and `caller` are the blocks a plan for a call from the line carries.',
    operationId: 'listPbxLines',
    tags: ['agent-db'],
    parameters: [
      { in: 'query', name: 'after', required: false, allowEmptyValue: true, schema: { type: 'string' }, description: 'The `next` of the page before. Absent or empty for the first page.' },
      { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: DEFAULT_PAGE }, description: 'How many organisations a page holds, not how many lines.' },
    ],
    responses: {
      200: {
        description: 'A page of lines',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['lines', 'next'],
              properties: {
                lines: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['username', 'organisationId', 'from', 'caller'],
                    properties: {
                      username: { type: 'string', description: "The SIP username of the line's account." },
                      organisationId: { type: 'string' },
                      from: {
                        type: 'object',
                        properties: {
                          lineId: { type: 'string' },
                          lineNumber: { type: 'integer' },
                          phoneId: { type: 'string' },
                          extensionId: nullable('string'),
                          extensionNumber: nullable('string'),
                          presentNumber: { ...nullable('string'), description: 'The number the line shows on a call out, with its `+`. Null when it has none.' },
                        },
                      },
                      caller: {
                        type: 'object',
                        properties: {
                          number: nullable('string'),
                          display: { type: 'string' },
                          internal: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
                next: { ...nullable('string'), description: 'The `after` of the next page. Null on the last page.' },
              },
            },
          },
        },
      },
      400: { description: 'The request is not valid', content: { 'application/json': { schema: { $ref: '#/components/schemas/DirectoryError' } } } },
      503: { description: '`phone_system_not_ready`: the database needs the phone system upgrade.', content: { 'application/json': { schema: { $ref: '#/components/schemas/DirectoryError' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { GET: list };
}
