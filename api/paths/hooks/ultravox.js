const { Agent, Instance, Call } = require('../../../lib/database');
const Handler = require('../../../lib/handlers/ultravox');

let appParameters, log;

module.exports = function (logger, voices, wsServer) {
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
    let { Agent: agent } = callRecord;
    req.log.debug({ callRecord, agent, call }, 'running ultravox webhook');
    if (!agent) {
      res.status(404).send('call not found');
    }
    else {
      let handler = new Handler({ agent });
      await handler.callEnded(call, callRecord);
      res.send({});
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