import { Agent, Instance, Call  } from '../../../lib/database.js';
import Handler from '../../../lib/handlers/ultravox.js';
import { maybeSendCallHook } from '../../../lib/call-hook.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    POST: recordHook,
  };
};

const recordHook = (async (req, res) => {
  let { call } = req.body;
  try {
    let callRecord = await Call.findOne({ where: { platformCallId: call.callId, platform: 'ultravox' }, include: [Agent] });
    let { Agent: agent } = callRecord || {};
    req.log.debug({ callRecord, agent, call }, 'running ultravox webhook');
    if (!agent) {
      res.status(404).send('call not found');
      return;
    }
    else {
      let handler = new Handler({ agent });
      await handler.callEnded(call, callRecord);

      // Resolve instance for callback payload (listenerId)
      let instance = null;
      if (callRecord?.instanceId) {
        instance = await Instance.findByPk(callRecord.instanceId);
      }

      // Fire callHook end callback for Ultravox WebRTC calls (non-blocking)
      maybeSendCallHook({
        event: 'end',
        call: callRecord,
        agent,
        listenerOrInstance: instance,
        reason: call?.reason,
        logger: req.log || log
      }).catch((err) => {
        (req.log || log)?.warn?.(err, 'error sending Ultravox callHook end callback');
      });

      res.send({});
      return;
    }
  }
  catch (err) {
    console.error(err, 'running ultravox webhook');
    req.log.error(err, 'running ultravox webhook');
    res.status(500).send(err);
  }
});

recordHook.apiDoc = {
  summary: 'Notes a call ended',
  description: 'Notes a call ended',
  operationId: 'recordHook',
  tags: ["Hooks"],
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: "object",
          properties: {
            call: {
              type: "object"
            }
          }
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Hook ran successfully'
    },
    default: {
      description: 'An error occurred',
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/Error'
          }
        }
      }
    }
  }
};