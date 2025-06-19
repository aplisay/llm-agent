import { fileURLToPath } from 'node:url';
import logger from '../../lib/logger.js';
import { WorkerOptions, cli, defineAgent, multimodal } from '@livekit/agents';
import { RoomServiceClient, SipClient } from 'livekit-server-sdk';
import * as openai from '@livekit/agents-plugin-openai';
import dotenv from 'dotenv';
import { Agent, Instance, Call, TransactionLog, PhoneNumber } from '../../lib/database.js';
import { functionHandler } from '../../lib/function-handler.js';
const encoder = new TextEncoder();
dotenv.config();

console.log(process.argv, 'invoked with args');



const roomService = new RoomServiceClient(process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET);



async function transferParticipant(roomName, participant, transferTo, aplisayId) {
  logger.info({ roomName, participant, transferTo }, "transfer participant initiated");

  const sipTransferOptions = {
    playDialtone: false
  };

  const result = await sipClient.transferSipParticipant(roomName, participant, transferTo, sipTransferOptions);
  logger.info({ result }, 'transfer participant result');
}

async function bridgeParticipant(roomName, participant, bridgeTo, aplisayId) {
  logger.info({ roomName, participant, bridgeTo }, "bridge participant initiated");

  const sipClient = new SipClient(process.env.LIVEKIT_URL,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET);

  // Outbound trunk to use for the call
  const trunkId = 'ST_xcWCuSmt73sL';

  const sipParticipantOptions = {
    participantIdentity: 'sip-test',
    headers: {
      'X-Aplisay-Trunk': aplisayId
    },
    participantName: 'Test Caller',
    krispEnabled: true,
    waitUntilAnswered: true
  };

  const newParticipant = await sipClient.createSipParticipant(
    trunkId,
    bridgeTo,
    roomName,
    sipParticipantOptions
  );
  logger.info({ newParticipant }, 'new participant result');
  return newParticipant;
}



export default defineAgent({
  entry: async (ctx) => {




    await ctx.connect();
    const room = ctx.room;
    let instance, agent, number;
    const participant = await ctx.waitForParticipant();
    let bridgedParticipant;

    try {

      // Either we are WebRTC and have participant metadata, or we are SIP and have calledId and callerId
      let instanceId = participant.metadata;
      let { 'sip.trunkPhoneNumber': calledId, 'sip.phoneNumber': callerId, 'sip.h.x-aplisay-trunk': aplisayId } = participant?.attributes || {};

      const transfer = async (args) => {
        logger.info({ args, number: args.number, identity: participant.info['identity'], room, aplisayId }, 'transfer participant');
        bridgedParticipant = await bridgeParticipant(room.name, participant.info['identity'], args.number, aplisayId);
        logger.info({ bridgedParticipant }, 'new participant created');
        await model.close();
        return bridgedParticipant;
      };

      calledId = calledId?.replace('+', '');
      if (instanceId) {
        instance = await Instance.findByPk(instanceId, { include: Agent });
      }
      else if (calledId) {
        logger.info({ callerId, calledId }, 'new Livekit call');
        ({ number, instance, agent } = await Agent.fromNumber(calledId));
      }
      if (!instance) {
        logger.error({ participant }, 'no instance found');
        throw new Error('No instance found');
      }
      agent = agent || instance?.Agent;
      const { userId, organisationId, options: { fallback: { number: fallbackNumbers } = {} } = {} } = agent;
      logger.info({ agent, instance }, 'new room instance');

      const call = await Call.create({
        userId,
        organisationId,
        instanceId: instance.id,
        agentId: agent.id,
        calledId,
        callerId,
        metadata: {
          ...instance.metadata,
          aplisay: {
            callerId,
            calledId,
            fallbackNumbers,
            model: agent.modelName,
          }
        }
      });
      await TransactionLog.create({ userId, organisationId, callId: call.id, type: 'answer', data: instance.id, isFinal: true });

      const { prompt, modelName, options, functions, keys } = agent;
      logger.debug({ agent, instanceId, instance, prompt, modelName, options, functions }, 'got agent');

      const sendMessage = async (message) => {
        let [type, data] = Object.entries(message)[0];
        ctx.room.localParticipant.publishData(encoder.encode(JSON.stringify(message)), { reliable: true });
        await TransactionLog.create({ userId, organisationId, callId: call.id, type, data: JSON.stringify(data), isFinal: true });
      };

      const model = new openai.realtime.RealtimeModel({
        instructions: agent?.prompt || 'You are a helpful assistant.',
      });
      const fncCtx = functions.reduce((acc, fnc) => ({
        ...acc,
        [fnc.name]: {
          description: fnc.description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(Object.entries(fnc.input_schema.properties).map(([key, value]) => ([key, { ...value, required: undefined }]))),
            required: Object.keys(fnc.input_schema.properties).filter(key => fnc.input_schema.properties[key].required) || []
          },
          execute: async (args) => {
            logger.debug({ name: fnc.name, args, fnc }, `Got function call ${fnc.name}`);
            let { function_results } = await functionHandler([{ ...fnc, input: args }], functions, keys, sendMessage, {}, { transfer }); // fix metadata here
            let [{ result: data }] = function_results;
            logger.debug({ data }, `returning ${JSON.stringify(data)}`);
            return JSON.stringify(data);
          }
        }

      }), {});
      logger.debug({ model, fncCtx }, 'got fncCtx');
      const lkAgent = new multimodal.MultimodalAgent({
        model,
        fncCtx
      });

      const session = await lkAgent
        .start(ctx.room)
        .then((session) => session);
      session.on('input_speech_transcription_completed', ({ transcript }) => sendMessage({ user: transcript }));
      session.on('response_output_added', (newOutput) => logger.debug({ newOutput }));
      session.on('response_output_done', output => sendMessage({ agent: output?.content?.[0]?.text }));
      ctx.room.on('participantDisconnected', async (p) => {
        logger.info({ p }, 'participant disconnected');
        if (p.info.identity === participant.info.identity) {
          logger.info({ participant }, 'Original participant disconnected, closing realtime model');
          await model.close();
          logger.info({ participant }, 'model closed');
        }
        if (p.info.sid === bridgedParticipant?.participantId) {
          logger.info({ bridgedParticipant }, 'Bridged participant disconnected, closing whole room');
          room && room.name && await roomService.deleteRoom(room.name);
          logger.info({ bridgedParticipant }, 'room closed');
        }
      });

      session.response.create();
    }
    catch (e) {
      logger.error(`error: closing room ${e.message} ${e.stack}`);
      room && room.name && await roomService.deleteRoom(room.name);
    }
  }
});

async function setupSIPClients() {
  const sipClient = new SipClient(process.env.LIVEKIT_URL, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);

  const phoneNumbers = (await PhoneNumber.findAll({ where: { handler: 'livekit' } })).map(p => `+${p.number}`);
  logger.info({ phoneNumbers }, 'Phone numbers');
  if (!phoneNumbers.length) {
    logger.info('No phone numbers found');
    return {};
  }
  const sipTrunks = await sipClient.listSipInboundTrunk();
  let sipTrunk = sipTrunks.find(t => t.name === 'Aplisay');
  if (!sipTrunk) {
    sipTrunk = await sipClient.createSipInboundTrunk('Aplisay', phoneNumbers);
    logger.info({ sipTrunk }, 'SIP trunk created');
  }
  else {
    logger.info({ sipTrunk }, 'SIP trunk found');
    // sync phone numbers from out database to livekit
    if (sipTrunk.numbers.length !== phoneNumbers.length || sipTrunk.numbers.some(n => !phoneNumbers.includes(n))) {
      sipTrunk = await sipClient.updateSipInboundTrunk(sipTrunk.sipTrunkId, {
        numbers: phoneNumbers,
      });
    }
    logger.info({ sipTrunk }, 'SIP trunk updated');
  }
  if (!sipTrunk) {
    throw new Error('LIvekit SIP trunk not found and can\'t be created');
  }

  const dispatchRules = await sipClient.listSipDispatchRule();
  let dispatchRule = dispatchRules.find(d => d.name === 'Aplisay');
  if (!dispatchRule) {
    dispatchRule = await sipClient.createSipDispatchRule({
      type: 'individual',
      roomPrefix: 'call'
    },
      {
        name: 'Aplisay',
        roomConfig: {
          agents: [{
            agentName: 'realtime'
          }]
        }
      }
    );
    logger.info({ dispatchRule }, 'SIP dispatch rule created');
  }
  if (!dispatchRule) {
    throw new Error('Livekit SIP dispatch rule not found and can\'t be created');
  }

  return { phoneNumbers, dispatchRule };
}

if (!process.argv[1].match(/job_proc_lazy_main.js/)) {
  setupSIPClients().then(({ phoneNumbers, dispatchRule }) => {
    logger.info({ phoneNumbers, dispatchRule }, 'SIP clients setup');
    cli.runApp(new WorkerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: 'realtime'
    }));
  });
}
else {
  cli.runApp(new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'realtime'
  }));
}
cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
}));
