import { fileURLToPath } from 'node:url';
import logger from '../../lib/logger.js';
import { WorkerOptions, cli, defineAgent, multimodal } from '@livekit/agents';
import { SipClient } from 'livekit-server-sdk';
import * as openai from '@livekit/agents-plugin-openai';
import dotenv from 'dotenv';
import { Agent, Instance, Call, TransactionLog, PhoneNumber } from '../../lib/database.js';
import { functionHandler } from '../../lib/function-handler.js';
const encoder = new TextEncoder();
dotenv.config();


export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();
    const room = ctx.room;

    const participant = await ctx.waitForParticipant();
    logger.info({ participant }, 'new participant');
    const instanceId = participant.metadata;
    const instance = await Instance.findOne({ where: { id: participant.metadata }, include: Agent });
    const agent = instance?.Agent;
    const { userId, organisationId } = instance;
    logger.info({ agent, instance }, 'new room instance');
    const call = await Call.create({ userId, organisationId, instanceId: instance.id, callerId: instance.id });
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
          let { function_results } = await functionHandler([{ ...fnc, input: args }], functions, keys, sendMessage);
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
      if (p.info.identity === participant.info.identity) {
        logger.info({ participant }, 'Closing realtime model');
        await model.close();
        logger.info({ participant }, 'model closed');
      }
    });

    session.response.create();
  },
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


setupSIPClients().then(({ phoneNumbers, dispatchRule }) => {
  logger.info({ phoneNumbers, dispatchRule }, 'SIP clients setup');
  cli.runApp(new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'realtime'
  }));
});

