import {
  claimRecord, requireEmergencyService, sendEmergencyRecordError,
} from '../../../../lib/emergency-records.js';
import { CLAIM_MS } from '../../../../lib/emergency-record-rules.js';
import {
  EMERGENCY_RECORDS_TAG, numberParam, ref, record, body, errorResponses, conflict,
} from '../../../../lib/emergency-record-api-docs.js';

/**
 * POST /api/emergency-records/{number}/claim: take a number for one send, so
 * that two senders cannot both send its record to the carrier.
 */
export default function (logger) {
  const claim = async (req, res) => {
    if (!requireEmergencyService(res, 'update')) return;
    try {
      res.send(await claimRecord(req.params.number, req.body?.expect));
    } catch (err) {
      sendEmergencyRecordError(res, err, logger, 'error claiming an emergency record');
    }
  };
  claim.apiDoc = {
    summary: 'Take a number for one send.',
    description: `The claim lasts ${CLAIM_MS / 60000} minutes, and the next write of the record ends it. `
      + 'The answer is the record with a new `version`: the write that follows names it. '
      + 'While a claim is live no other claim is given and nobody else may write the record.',
    operationId: 'claimEmergencyRecord',
    tags: [EMERGENCY_RECORDS_TAG],
    parameters: [numberParam],
    requestBody: body({ type: 'object', required: ['expect'], properties: { expect: ref('EmergencyRecordExpect') } }),
    responses: { 200: record('The record, claimed'), 409: conflict, ...errorResponses },
  };
  return { POST: claim };
}
