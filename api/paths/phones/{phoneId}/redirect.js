import { redirectStatus } from '../../../../lib/provisioning/phones.js';
import { directoryContext, attempt } from '../../../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, pathId, errorResponses, ok } from '../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const get = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'provision', { gate: true });
    if (!ctx) return;
    res.send(await redirectStatus(ctx, req.params.phoneId));
  });
  get.apiDoc = {
    summary: "Read what the vendor's redirect service holds for a desk phone.",
    description: 'Needs `phone:provision`. Asks the redirect service now. `redirect` is null when none is set up. '
      + '`lastRequestAt` is when the phone last asked the service where to fetch its settings: null means it has not '
      + 'called in yet.',
    operationId: 'getPhoneRedirect',
    tags: [PHONES_TAG],
    parameters: [pathId('phoneId', 'The id of the phone.'), organisationIdQuery],
    responses: {
      200: ok('The redirect', {
        redirect: {
          type: 'object',
          nullable: true,
          properties: {
            service: { type: 'string' },
            bound: { type: 'boolean' },
            ours: { type: 'boolean', description: 'Whether this platform made the binding.' },
            lastRequestAt: { type: 'string', nullable: true },
            firmware: { type: 'string', nullable: true },
            error: { type: 'string', description: 'Set when the service could not be asked.' },
          },
        },
      }),
      ...errorResponses,
    },
  };
  return { GET: get };
}
