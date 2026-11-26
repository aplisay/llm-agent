import {
  listRecords, requireEmergencyService, sendEmergencyRecordError, DEFAULT_PAGE, MAX_PAGE,
} from '../../lib/emergency-records.js';
import { RECORD_STATES } from '../../lib/emergency-record-rules.js';
import { EMERGENCY_RECORDS_TAG, ref, errorResponses } from '../../lib/emergency-record-api-docs.js';

/**
 * GET /api/emergency-records: the emergency address records of every
 * organisation, a page at a time. For the service that sends the records to
 * the carrier, with its own key (docs/emergency-records.md).
 */
export default function (logger) {
  const list = async (req, res) => {
    if (!requireEmergencyService(res, 'read')) return;
    try {
      const { states, after } = req.query || {};
      // As it was sent: the query parser rounds a fraction down before this runs.
      const limit = new URL(req.originalUrl, 'http://localhost').searchParams.get('limit');
      res.send(await listRecords({
        states: typeof states === 'string' && states ? states.split(',').map((state) => state.trim()).filter(Boolean) : undefined,
        after: typeof after === 'string' ? after : '',
        limit: limit === null || limit === '' ? DEFAULT_PAGE : (/^\d+$/.test(limit) ? Number(limit) : NaN),
      }));
    } catch (err) {
      sendEmergencyRecordError(res, err, logger, 'error listing emergency records');
    }
  };
  list.apiDoc = {
    summary: 'List emergency address records.',
    description: 'The records of every organisation, in number order. Paged by number: pass the `next` of one page as the `after` of the following one. '
      + 'Only a key of the `emergencyService` role may call it.',
    operationId: 'listEmergencyRecords',
    tags: [EMERGENCY_RECORDS_TAG],
    parameters: [
      { in: 'query', name: 'states', required: false, schema: { type: 'string' }, description: `Only records in these states, separated by commas. One or more of ${RECORD_STATES.join(', ')}. All states when absent.` },
      { in: 'query', name: 'after', required: false, allowEmptyValue: true, schema: { type: 'string' }, description: 'Only numbers after this one. Empty for the first page.' },
      { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: DEFAULT_PAGE } },
    ],
    responses: {
      200: {
        description: 'A page of records',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items', 'next'],
              properties: {
                items: { type: 'array', items: ref('EmergencyRecord') },
                next: { type: 'string', nullable: true, description: 'The `after` of the next page. Null on the last page.' },
              },
            },
          },
        },
      },
      ...errorResponses,
    },
  };
  return { GET: list };
}
