import { requirePermission } from '../../../../lib/auth/permissions.js';
import { findVisibleCall } from '../../../../lib/call-visibility.js';
import { phoneSystemReady } from '../../../../lib/capabilities.js';
import { listEvents } from '../../../../lib/pbx/call-records.js';
import { shownEvent } from '../../../../lib/pbx/call-event-view.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function (logger) {
  const callEvents = async (req, res) => {
    if (!requirePermission(res, 'call', 'read')) return;
    const { callId } = req.params;
    const notFound = () => res.status(404).send({ error: `Call with ID ${callId} not found` });
    try {
      if (!UUID_RE.test(callId ?? '')) return notFound();
      // A call out of sight, and a deleted call, answer as a call that does not exist.
      const call = await findVisibleCall(res.locals.user, callId, { attributes: ['id'] });
      if (!call) return notFound();
      if (!phoneSystemReady()) return res.send({ events: [] });
      res.send({ events: (await listEvents(call.id)).map(shownEvent) });
    } catch (error) {
      (req.log || logger).error({ err: error, callId }, 'call events read failed');
      res.status(500).send({ error: 'Internal server error' });
    }
  };

  callEvents.apiDoc = {
    summary: 'What happened on a phone system call',
    description: 'The events call control recorded on a phone system call, oldest first: which phones rang and in what order, '
      + 'which answered, a leg that was skipped and why, a refusal, hold, and the recording. Shown to whoever may see the call. '
      + 'An agent call has none. See "A call\'s events" in docs/phone-system.md.',
    tags: ['Calls'],
    operationId: 'getCallEvents',
    parameters: [
      { name: 'callId', in: 'path', description: 'The call ID', required: true, schema: { type: 'string' } },
    ],
    responses: {
      200: {
        description: 'The events',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { events: { type: 'array', items: { $ref: '#/components/schemas/CallEvent' } } },
            },
          },
        },
      },
      404: {
        description: 'No such call, a call the caller may not see, or a deleted call',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } },
      },
      default: {
        description: 'Another kind of error occurred',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  };

  return { GET: callEvents };
}
