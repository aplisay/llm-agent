import { fileURLToPath } from 'node:url';
import logger from '../../lib/logger.js';
import { WorkerOptions, cli, defineAgent, multimodal } from '@livekit/agents';
import { RoomServiceClient, SipClient } from 'livekit-server-sdk';
import { SIPHeaderOptions, SIPTransport } from '@livekit/protocol';
import * as openai from '@livekit/agents-plugin-openai';
import * as ultravox from '@aplisay/agents-plugin-ultravox';
import dotenv from 'dotenv';
import { Agent, Instance, Call, TransactionLog, PhoneNumber, stopDatabase } from '../../lib/database.js';
import { functionHandler } from '../../lib/function-handler.js';
const encoder = new TextEncoder();
dotenv.config();

const events = [
  'input_speech_committed',
  'input_speech_started',
  'input_speech_stopped',
  'input_speech_transcription_completed',
  'input_speech_transcription_failed',
  'response_created',
  'response_done',
  'metrics_collected',
  'response_output_added',
  'function_call_started',
  'function_call_completed',
  'function_call_failed',
  'response_output_done',
  'response_content_added',
  'response_content_done',
  'response_text_delta',
  'response_text_done',
];


const models = {
  ultravox,
  openai
};

logger.info({ argv: process.argv, models }, 'worker started');

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_SIP_OUTBOUND, LIVEKIT_SIP_USERNAME, LIVEKIT_SIP_PASSWORD } = process.env;



const roomService = new RoomServiceClient(
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
);





async function transferParticipant(roomName, participant, transferTo, aplisayId) {
  logger.info({ roomName, participant, transferTo }, "transfer participant initiated");

  const sipTransferOptions = {
    playDialtone: false
  };

  const result = await sipClient.transferSipParticipant(roomName, participant, transferTo, sipTransferOptions);
  logger.info({ result }, 'transfer participant result');
}

async function bridgeParticipant(roomName, participant, bridgeTo, aplisayId, callerId) {


  const sipClient = new SipClient(LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET);

  const outboundSipTrunks = await sipClient.listSipOutboundTrunk();
  let outboundSipTrunk = outboundSipTrunks.find(t => t.name === 'Aplisay Outbound');
  const { sipTrunkId } = outboundSipTrunk;

  // Outbound trunk to use for the c
  const sipParticipantOptions = {
    participantIdentity: 'sip-outbound-call',
    headers: {
      'X-Aplisay-Trunk': aplisayId
    },
    participantName: 'Aplisay Outbound Call',
    fromNumber: callerId.replace(/^(?!\+)/, '+'),
    krispEnabled: true,
    waitUntilAnswered: true
  };

  logger.info({ roomName, participant, bridgeTo, callerId, sipParticipantOptions }, "bridge participant initiated");

  const newParticipant = await sipClient.createSipParticipant(
    sipTrunkId,
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
    let model;

    try {

      // Either we are WebRTC and have participant metadata, or we are SIP and have calledId and callerId
      let instanceId = participant.metadata;
      let { 'sip.trunkPhoneNumber': calledId, 'sip.phoneNumber': callerId, 'sip.h.x-aplisay-trunk': aplisayId } = participant?.attributes || {};

      calledId = calledId?.replace('+', '');
      if (instanceId) {
        instance = await Instance.findByPk(instanceId, { include: Agent });
      }
      else if (calledId) {
        logger.info({ callerId, calledId, aplisayId }, 'new Livekit call');
        ({ number, instance, agent } = await Agent.fromNumber(calledId));
      }
      if (!instance) {
        logger.error({ participant }, 'no instance found');
        throw new Error('No instance found');
      }
      agent = agent || instance?.Agent;
      const { userId, organisationId, options: { fallback: { number: fallbackNumbers } = {} } = {} } = agent;
      logger.info({ agent, instance }, 'new room instance');


      const transfer = async (args) => {
        if (!args.number.match(/^(\+44|44|0)[1237]\d{6,15}$/)) {
          logger.info({ args }, 'invalid number');
          throw new Error('Invalid number: only UK geographic and mobile numbers are supported currently as transfer targets');
        }
        try {
          logger.info({ args, number: args.number, identity: participant.info['identity'], room, aplisayId }, 'transfer participant');

          bridgedParticipant = await bridgeParticipant(room.name, participant.info['identity'], args.number, aplisayId, calledId);
          logger.info({ bridgedParticipant }, 'new participant created');
          model && await model.close() && (model = null);
          return bridgedParticipant;
        }
        catch (e) {
          console.log({ e, type: typeof e, message: e.message, stack: e.stack }, 'transfer error');
          logger.error({ e }, 'error transferring participant');
          throw e;
        }
      };

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

      const plugin = modelName.match(/livekit:(\w+)\//)?.[1];
      const realtime = plugin && models[plugin]?.realtime;
      if (!realtime) {
        logger.error({ modelName, plugin, realtime, plugin: models[plugin], models }, 'Unsupported model');
        throw new Error(`Unsupported model: ${modelName} ${plugin}`);
      }
      model = new realtime.RealtimeModel({
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
      events.forEach(event => {
        session.on(event, (data) => {
          logger.debug({ event }, `Got event ${event}`);
        });
      });
      session.on('input_speech_transcription_completed', ({ transcript }) => sendMessage({ user: transcript }));
      session.on('response_output_added', (newOutput) => logger.debug({ newOutput }));
      session.on('response_output_done', output => {
        output?.content?.[0]?.audio && (output.content[0].audio = undefined);
        logger.debug({ output }, 'response_output_done');
        sendMessage({ agent: output?.content?.[0]?.text });
      });
      ctx.room.on('participantDisconnected', async (p) => {
        logger.info({ p }, 'participant disconnected');
        if (p.info.identity === participant.info.identity) {
          logger.info({ participant }, 'Original participant disconnected, closing realtime model');
          model && await model.close() && (model = null);
          room && room.name && await roomService.deleteRoom(room.name);
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
  const inboundSipTrunks = await sipClient.listSipInboundTrunk();
  let inboundSipTrunk = inboundSipTrunks.find(t => t.name === 'Aplisay');
  if (!inboundSipTrunk) {
    inboundSipTrunk = await sipClient.createSipInboundTrunk(
      'Aplisay',
      phoneNumbers,
      {
        includeHeaders: SIPHeaderOptions.SIP_X_HEADERS
      }
    );
    logger.info({ inboundSipTrunk }, 'SIP trunk created');
  }
  else {
    logger.info({ inboundSipTrunk }, 'SIP trunk found');
    // sync phone numbers from out database to livekit
    if (inboundSipTrunk.numbers.length !== phoneNumbers.length || inboundSipTrunk.numbers.some(n => !phoneNumbers.includes(n))) {
      inboundSipTrunk = await sipClient.updateSipInboundTrunk(inboundSipTrunk.sipTrunkId, {
        numbers: phoneNumbers
      });
    }
    logger.info({ inboundSipTrunk }, 'SIP trunk updated');
  }
  if (!inboundSipTrunk) {
    throw new Error('LIvekit SIP trunk not found and can\'t be created');
  }

  const outboundSipTrunks = await sipClient.listSipOutboundTrunk();
  let outboundSipTrunk = outboundSipTrunks.find(t => t.name === 'Aplisay Outbound');
  outboundSipTrunk && await sipClient.deleteSipTrunk(outboundSipTrunk.sipTrunkId);
  outboundSipTrunk = null;
  if (!outboundSipTrunk) {
    outboundSipTrunk = await sipClient.createSipOutboundTrunk(
      "Aplisay Outbound",
      LIVEKIT_SIP_OUTBOUND,
      phoneNumbers,
      {
        transport: SIPTransport.SIP_TRANSPORT_TCP,
        authUsername: LIVEKIT_SIP_USERNAME,
        authPassword: LIVEKIT_SIP_PASSWORD
      }
    );
    logger.info({ outboundSipTrunk }, 'SIP outbound trunk created');
  }
  else {
    logger.info({ outboundSipTrunk }, 'SIP outbound trunk found');
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

if (process.argv[2] === 'setup') {
  setupSIPClients().then(({ phoneNumbers, dispatchRule }) => {
    logger.info({ phoneNumbers, dispatchRule }, 'SIP clients setup');
    cli.runApp(new WorkerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: 'realtime'
    }));
  });
  logger.info('SIP clients setup, exiting');
  stopDatabase();
  process.exit(0);
}
else {

  cli.runApp(new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'realtime',
    port: 8081
  }));

  cli.runApp(new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    port: 8082
  }));
  
}
