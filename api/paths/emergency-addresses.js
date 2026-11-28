import { listNumberAddresses, numberAddressContext, sendEmergencyRecordError } from '../../lib/emergency-records.js';
import { EMERGENCY_ADDRESSES_TAG, organisationParam, ref, addressErrors } from '../../lib/emergency-record-api-docs.js';

/**
 * GET /api/emergency-addresses: the emergency address record of each of an
 * organisation's numbers, for the organisation's own users
 * (docs/emergency-records.md).
 */
export default function (logger) {
  const list = async (req, res) => {
    const context = await numberAddressContext(req, res, 'read');
    if (!context) return;
    try {
      res.send(await listNumberAddresses(context.organisation.id, { full: context.full }));
    } catch (err) {
      sendEmergencyRecordError(res, err, logger, 'error listing emergency addresses');
    }
  };
  list.apiDoc = {
    summary: "List the emergency address records of an organisation's numbers.",
    description: 'For each of the organisation\'s numbers that has a record here: its state, and which address it should hold. '
      + 'The addresses themselves, and the carrier\'s words, are given only to a caller who may read the organisation\'s settings.',
    operationId: 'listEmergencyAddresses',
    tags: [EMERGENCY_ADDRESSES_TAG],
    parameters: [organisationParam],
    responses: {
      200: {
        description: 'The records, in number order',
        content: {
          'application/json': {
            schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: ref('NumberEmergencyAddress') } } },
          },
        },
      },
      ...addressErrors,
    },
  };
  return { GET: list };
}
