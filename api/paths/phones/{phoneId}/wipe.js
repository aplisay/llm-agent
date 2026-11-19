import { wipePhone } from '../../../../lib/provisioning/phones.js';
import { directoryContext, attempt } from '../../../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, pathId, errorResponses, ok, ref } from '../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const wipe = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'provision', { gate: true });
    if (!ctx) return;
    const result = await wipePhone(ctx, req.params.phoneId);
    (req.log || logger).info({
      audit: 'phone-wiped',
      phoneId: req.params.phoneId,
      organisationId: ctx.organisation.id,
      userId: res.locals.user?.id,
    }, 'phone wiped');
    res.send(result);
  });
  wipe.apiDoc = {
    summary: 'Wipe a desk phone.',
    description: 'Needs `phone:provision`. The phone\'s settings address stops working and its lines can no longer '
      + 'register, whatever the phone still holds. The phone stays in the list in state `wiped`. '
      + '`POST /phones/{phoneId}/provision` brings it back.',
    operationId: 'wipePhone',
    tags: [PHONES_TAG],
    parameters: [pathId('phoneId', 'The id of the phone.'), organisationIdQuery],
    responses: { 200: ok('The phone after the wipe', { phone: ref('Phone') }), ...errorResponses },
  };
  return { POST: wipe };
}
