import { provisionPhone } from '../../../../lib/provisioning/phones.js';
import { directoryContext, attempt } from '../../../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, pathId, errorResponses, ok, ref } from '../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const provision = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'provision', { gate: true });
    if (!ctx) return;
    const result = await provisionPhone(ctx, req.params.phoneId);
    // An audit line for every new address. Never the address.
    (req.log || logger).info({
      audit: 'phone-provisioned',
      phoneId: req.params.phoneId,
      organisationId: ctx.organisation.id,
      userId: res.locals.user?.id,
    }, 'phone given a new settings address');
    res.set('Cache-Control', 'no-store').send(result);
  });
  provision.apiDoc = {
    summary: 'Give a desk phone a new settings address.',
    description: 'Needs `phone:provision`. The answer holds the address the phone fetches its settings from, and it can '
      + 'not be read again. An earlier address of the phone stops working at once. The phone must present its factory '
      + 'certificate when it fetches: the address alone opens nothing. Until its first use the address stops working at '
      + '`expiresAt`: 7 days, or 30 when a redirect service was told the address. A wiped phone is brought back by this.',
    operationId: 'provisionPhone',
    tags: [PHONES_TAG],
    parameters: [pathId('phoneId', 'The id of the phone.'), organisationIdQuery],
    responses: {
      200: ok('The phone and its new settings address', {
        phone: ref('Phone'),
        provisioning: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The settings address. `{mac}` is filled in by the phone.' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        redirect: {
          type: 'object',
          nullable: true,
          description: 'Null when no redirect service is set up. `bound` true: a factory-reset phone finds the address by '
            + 'itself. `bound` false: `error` says why (`mac_taken` when another company holds the phone at the vendor), '
            + 'and the address can still be typed into the phone.',
          properties: { service: { type: 'string' }, bound: { type: 'boolean' }, error: { type: 'string' } },
        },
      }),
      ...errorResponses,
    },
  };
  return { POST: provision };
}
