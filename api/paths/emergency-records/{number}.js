import {
  readRecord, writeRecord, requireEmergencyService, sendEmergencyRecordError,
} from '../../../lib/emergency-records.js';
import {
  EMERGENCY_RECORDS_TAG, numberParam, ref, record, body, errorResponses, conflict,
} from '../../../lib/emergency-record-api-docs.js';

/**
 * /api/emergency-records/{number}: one number's emergency address record.
 * For the service that sends the records to the carrier, with its own key.
 */
export default function (logger) {
  const get = async (req, res) => {
    if (!requireEmergencyService(res, 'read')) return;
    try {
      res.send(await readRecord(req.params.number));
    } catch (err) {
      sendEmergencyRecordError(res, err, logger, 'error reading an emergency record');
    }
  };
  get.apiDoc = {
    summary: 'Read one emergency address record as it is now.',
    operationId: 'getEmergencyRecord',
    tags: [EMERGENCY_RECORDS_TAG],
    parameters: [numberParam],
    responses: { 200: record('The record'), ...errorResponses },
  };

  const put = async (req, res) => {
    if (!requireEmergencyService(res, 'update')) return;
    try {
      const { expect, ...patch } = req.body || {};
      const written = await writeRecord(req.params.number, expect, patch);
      logger.info({
        audit: 'emergency-record-write', number: written.number, organisationId: written.organisationId, state: written.state, code: written.code,
      }, 'emergency record written');
      res.send(written);
    } catch (err) {
      sendEmergencyRecordError(res, err, logger, 'error writing an emergency record');
    }
  };
  put.apiDoc = {
    summary: 'Write the result of a send or of a status read.',
    description: 'The write names the record it read in `expect`, and is refused with 409 when the record is no longer that one. '
      + 'A write that follows a claim names the version the claim gave, and is taken whatever happened to the address meanwhile, '
      + 'unless the number moved to another organisation. Any write ends the claim. '
      + 'The state moves the key may make are listed in docs/emergency-records.md. Any other answers 422.',
    operationId: 'writeEmergencyRecord',
    tags: [EMERGENCY_RECORDS_TAG],
    parameters: [numberParam],
    requestBody: body(ref('EmergencyRecordWrite')),
    responses: {
      200: record('The record after the write'),
      409: conflict,
      422: { description: 'The key may not make this change of state. `code` is `move_not_allowed` or `state_required`.', content: { 'application/json': { schema: ref('EmergencyRecordError') } } },
      ...errorResponses,
    },
  };

  return { GET: get, PUT: put };
}
