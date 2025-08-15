import dotenv from 'dotenv';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { Room } from 'livekit-server-sdk';
import { defineAgent, multimodal } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as ultravox from '../plugins/ultravox/src/index.js';
import logger from '../agent-lib/logger.js';

import * as functionHandlerModule from '../agent-lib/function-handler.js';
import { bridgeParticipant } from './telephony.js';
import { getInstanceById, getInstanceByNumber, createCall, createTransactionLog } from './api-client.js';


dotenv.config();



// logger will be imported dynamically

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

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
] as const;

const models = {
  ultravox,
  openai
};

const roomService = new RoomServiceClient(
  LIVEKIT_URL!,
  LIVEKIT_API_KEY!,
  LIVEKIT_API_SECRET!
);

export default defineAgent({
  entry: async (ctx: any) => {

    await ctx.connect();
    const room: Room = ctx.room as Room;
    let instance: any = null;
    let agent: any | null = null;
    let number: any = null;
    let participant: any = null;
    let bridgedParticipant: any = null;
    let model: any = null;

    try {

      let { callerId, calledId, instanceId, aplisayId, outbound } = ctx.job.metadata || {};

      if (outbound) {
        if (!calledId || !callerId || !aplisayId || !instanceId) {
          logger.error({ ctx }, 'missing metadata for outbound call');
          throw new Error('Missing metadata for outbound call');
        }
        else {
          instance = await getInstanceById(instanceId);
        }

        if(!instance) {
          logger.error({ ctx }, `No instance found for outbound call (${calledId} => ${callerId}) ${instanceId} was incorrect`);
          throw new Error('No instance found for outbound call');
        }
        else {
          participant = await bridgeParticipant(room.name, callerId, aplisayId, calledId);
        }
        if(!participant) {
          logger.error({ ctx }, `Outbound call failed for (${calledId} => ${callerId})`);
          throw new Error('outbound call failed');
        }

      }
      else {

        participant = await ctx.waitForParticipant();
        
        ({ 'sip.trunkPhoneNumber': calledId, 'sip.phoneNumber': callerId, 'sip.h.x-aplisay-trunk': aplisayId } = ctx.job.metadata);
        calledId = calledId?.replace('+', '');
        callerId = callerId?.replace('+', '');
        aplisayId = aplisayId?.replace('+', '');
      

        // Either we are WebRTC and have participant metadata, or we are SIP and have calledId and callerId
        let instanceId = participant.metadata;
        ({ 'sip.trunkPhoneNumber': calledId, 'sip.phoneNumber': callerId, 'sip.h.x-aplisay-trunk': aplisayId } = participant?.attributes || {});
        // Remove + from the numbers
        calledId = calledId?.replace('+', '');
        callerId = callerId?.replace('+', '');

        if (instanceId) {
          instance = await getInstanceById(instanceId);
        }
        else if (calledId) {
          logger.info({ callerId, calledId, aplisayId }, 'new Livekit call');
          const result = await getInstanceByNumber(calledId);
          number = result.number;
          instance = result;
          agent = result.Agent;
        }

        if (!instance) {
          logger.error({ participant }, `no instance found for inbound call (${calledId} => ${callerId})`);
          throw new Error('No instance found');
        }

    
      }

      agent = agent || instance?.Agent || null;
      calledId = calledId || 'WebRTC';
      callerId = callerId || 'WebRTC';
      const { userId, modelName, organisationId, options = {} } = agent as any || {};
      const { fallback: { number: fallbackNumbers } = {} } = options;
      logger.info({ agent, instance, calledId, callerId, ctx, room, participant }, 'new room instance');

      const transfer = async (args: any) => {
        if (!args.number.match(/^(\+44|44|0)[1237]\d{6,15}$/)) {
          logger.info({ args }, 'invalid number');
          throw new Error('Invalid number: only UK geographic and mobile numbers are supported currently as transfer targets');
        }
        try {
          logger.info({ args, number: args.number, identity: participant.info['identity'], room, aplisayId }, 'transfer participant');

          bridgedParticipant = await bridgeParticipant(room.name, args.number, aplisayId, calledId);
          logger.info({ bridgedParticipant }, 'new participant created');
          model && await model.close() && (model = null);
          return bridgedParticipant;
        }
        catch (e) {
          console.log({ e, type: typeof e, message: (e as Error).message, stack: (e as Error).stack }, 'transfer error');
          logger.error({ e }, 'error transferring participant');
          throw e;
        }
      };

      const call = await createCall({
        userId,
        organisationId,
        instanceId: instance.id,
        agentId: agent.id,
        platform: 'livekit',
        platformCallId: room?.sid,
        calledId,
        callerId,
        modelName,
        options,
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

      const { metadata } = call;
      metadata.aplisay.callId = call.id;

      await createTransactionLog({ userId, organisationId, callId: call.id, type: 'answer', data: instance.id, isFinal: true });

      const { prompt, functions = [], keys = [] } = agent;
      logger.debug({ agent, instanceId: instance.id, instance, prompt, modelName, options, metadata, functions }, 'got agent');

      const sendMessage = async (message: any) => {
        const entries = Object.entries(message);
        if (entries.length > 0) {
          const [type, data] = entries[0] as [string, any];
          ctx.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true });
          await createTransactionLog({ userId, organisationId, callId: call.id, type, data: JSON.stringify(data), isFinal: true });
        }
      };

      const plugin = modelName.match(/livekit:(\w+)\//)?.[1];
      const realtime = plugin && (models as any)[plugin]?.realtime;
      if (!realtime) {
        logger.error({ modelName, plugin, realtime, models }, 'Unsupported model');
        throw new Error(`Unsupported model: ${modelName} ${plugin}`);
      }
      model = new realtime.RealtimeModel({
        instructions: agent?.prompt || 'You are a helpful assistant.',
        voice: agent?.options?.tts?.voice
      });
      const fncCtx = functions.reduce((acc: any, fnc: any) => ({
        ...acc,
        [fnc.name]: {
          description: fnc.description,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(Object.entries(fnc.input_schema.properties).map(([key, value]: [string, any]) => ([key, { ...value, required: undefined }]))),
            required: Object.keys(fnc.input_schema.properties).filter(key => fnc.input_schema.properties[key].required) || []
          },
          execute: async (args: any) => {
            logger.debug({ name: fnc.name, args, fnc }, `Got function call ${fnc.name}`);
            let result = await functionHandlerModule.functionHandler([{ ...fnc, input: args }], functions, keys, sendMessage, metadata, { transfer }) as any;
            let { function_results } = result;
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
        .then((session: any) => session);
      events.forEach(event => {
        session.on(event, (data: any) => {
          logger.debug({ event }, `Got event ${event}`);
        });
      });
      session.on('input_speech_transcription_completed', ({ transcript }: any) => sendMessage({ user: transcript }));
      session.on('response_output_added', (newOutput: any) => logger.debug({ newOutput }));
      session.on('response_output_done', (output: any) => {
        output?.content?.[0]?.audio && (output.content[0].audio = undefined);
        logger.debug({ output }, 'response_output_done');
        sendMessage({ agent: output?.content?.[0]?.text });
      });
      ctx.room.on('participantDisconnected', async (p: any) => {
        logger.info({ p }, 'participant disconnected');
        if (p.info.identity === participant.info.identity) {
          logger.info({ participant }, 'Original participant disconnected, closing realtime model');
          model && await model.close() && (model = null);
          call.end();
          room && room.name && await roomService.deleteRoom(room.name);
          logger.info({ participant }, 'model closed');
        }
        if (p.info.sid === bridgedParticipant?.participantId) {
          logger.info({ bridgedParticipant }, 'Bridged participant disconnected, closing whole room');
          room && room.name && await roomService.deleteRoom(room.name);
          logger.info({ bridgedParticipant }, 'room closed');
          call.end();
        }
      });

      (session as any).response.create();
      call.start();
    }
    catch (e) {
      logger.error(`error: closing room ${(e as Error).message} ${(e as Error).stack}`);
      room && room.name && await roomService.deleteRoom(room.name);
    }
  }
}); 