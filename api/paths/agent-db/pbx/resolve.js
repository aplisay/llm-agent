import { resolveRequest } from '../../../../lib/pbx/resolve.js';
import { sendPbxError } from '../../../../lib/pbx/errors.js';

/**
 * POST /api/agent-db/pbx/resolve: call control asks what a call should do.
 * Internal. It takes the call control token (x-callctl-token) only, never the
 * workers' shared token: see middleware/auth.js.
 *
 * Always 200 with a plan for a decided request. A call that cannot be routed
 * is a plan with `action: 'refuse'` and a `reason`, so the caller can tell
 * "refused" from "could not decide".
 */
export default function (logger) {
  const resolve = async (req, res) => {
    const { callId, request } = req.body || {};
    try {
      const plan = await resolveRequest(request);
      if (plan.action === 'refuse') {
        logger.info({ callId, kind: request?.kind, reason: plan.reason, organisationId: plan.organisationId }, 'phone system call refused');
      }
      res.send({ ...(callId ? { callId } : {}), ...plan });
    } catch (err) {
      sendPbxError(res, err, logger, 'error resolving a phone system call');
    }
  };
  resolve.apiDoc = {
    summary: 'Work out the ring plan for a call to a number, or for digits dialled on a line (internal).',
    operationId: 'resolvePbxCall',
    tags: ['agent-db'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['request'],
            properties: {
              callId: { type: 'string', description: "The caller's id for the call. Echoed in the answer." },
              request: {
                type: 'object',
                required: ['kind'],
                properties: {
                  kind: { type: 'string', enum: ['number', 'dialled', 'extension', 'line'] },
                  calledNumber: { type: 'string', description: 'kind number: the number that was called.' },
                  trunkId: { type: 'string', description: 'kind number: the trunk the call came in on.' },
                  callerId: { type: 'string', nullable: true },
                  fromEndpoint: { type: 'string', description: 'kind dialled: the SIP username of the line that dialled.' },
                  digits: { type: 'string', description: 'kind dialled: the digits dialled.' },
                  organisationId: { type: 'string', description: 'kinds extension and line.' },
                  extensionId: { type: 'string', description: 'kind extension.' },
                  lineNumber: { type: 'integer', description: 'kind line.' },
                  skip: { type: 'array', items: { type: 'string' }, description: 'kind extension: settings to pass over, such as "before".' },
                  hop: { type: 'integer', minimum: 0, description: 'kind extension: how many destinations this call has followed.' },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The plan. `action` is one of ring, forward, connection, agent, outside, emergency, release, refuse.', content: { 'application/json': { schema: { type: 'object' } } } },
      400: { description: 'The request is not valid', content: { 'application/json': { schema: { $ref: '#/components/schemas/DirectoryError' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { POST: resolve };
}
