import {
  readNumberAddress, setNumberAddress, numberAddressContext, sendEmergencyRecordError,
} from '../../../lib/emergency-records.js';
import {
  EMERGENCY_ADDRESSES_TAG, numberParam, organisationParam, ref, body, addressErrors,
} from '../../../lib/emergency-record-api-docs.js';

/**
 * /api/emergency-addresses/{number}: one number's emergency address record,
 * for its organisation's own users. The write sets which address the record
 * should hold. It sends nothing: the sending service finds the change on its
 * next run (docs/emergency-records.md).
 */
export default function (logger) {
  const read = async (req, res) => {
    const context = await numberAddressContext(req, res, 'read');
    if (!context) return;
    try {
      res.send(await readNumberAddress(context.organisation.id, req.params.number, { full: context.full }));
    } catch (err) {
      sendEmergencyRecordError(res, err, logger, 'error reading an emergency address');
    }
  };
  read.apiDoc = {
    summary: "Read one number's emergency address record.",
    operationId: 'getEmergencyAddress',
    tags: [EMERGENCY_ADDRESSES_TAG],
    parameters: [numberParam, organisationParam],
    responses: { 200: { description: 'The record', content: { 'application/json': { schema: ref('NumberEmergencyAddress') } } }, ...addressErrors },
  };

  const write = async (req, res) => {
    const context = await numberAddressContext(req, res, 'update');
    if (!context) return;
    try {
      const record = await setNumberAddress(context.organisation.id, req.params.number, req.body);
      // No address in the log line.
      logger.info({
        audit: 'emergency-address-set', number: record.number, organisationId: context.organisation.id,
        userId: res.locals.user?.id, mode: record.mode, fields: Object.keys(req.body || {}),
      }, 'emergency address of a number changed');
      res.send(record);
    } catch (err) {
      sendEmergencyRecordError(res, err, logger, 'error setting an emergency address');
    }
  };
  write.apiDoc = {
    summary: "Set which address a number's emergency record should hold.",
    description: 'Send `mode`, `address`, or both. `address` is the number\'s own address, and null removes it. '
      + 'Nothing is sent to the carrier and the state is not changed: the sending service sends the changed record on its next run.',
    operationId: 'setEmergencyAddress',
    tags: [EMERGENCY_ADDRESSES_TAG],
    parameters: [numberParam, organisationParam],
    requestBody: body(ref('NumberEmergencyAddressWrite')),
    responses: { 200: { description: 'The record after the change', content: { 'application/json': { schema: ref('NumberEmergencyAddress') } } }, ...addressErrors },
  };

  return { GET: read, PUT: write };
}
