import { fileURLToPath } from 'node:url';
import logger from '../../lib/logger.js';
import path from 'node:path';
import { WorkerOptions, cli, defineAgent, multimodal } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import dotenv from 'dotenv';
import { z } from 'zod';
import { Agent, Instance } from '../../lib/database.js';
import { functionHandler } from '../../lib/function-handler.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const encoder = new TextEncoder();
dotenv.config();


export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();
    logger.info('starting assistant example agent');
    const participant = await ctx.waitForParticipant();
    const instanceId = participant.metadata;
    const instance = await Instance.findOne({ where: { id: participant.metadata }, include: Agent });
    const agent = instance?.Agent;
    const { prompt, modelName, options, functions, keys } = agent;
    logger.info({ agent, instanceId, instance, prompt, modelName, options, functions }, 'got agent');
    
    const sendMessage = (message) => ctx.room.localParticipant.publishData(encoder.encode(JSON.stringify(message)), { reliable: true });

    const model = new openai.realtime.RealtimeModel({
      instructions: agent?.prompt || 'You are a helpful assistant.',
    });
    const lkAgent = new multimodal.MultimodalAgent({
      model,
      fncCtx: functions.reduce((acc, fnc) => ({
        ...acc,
        [fnc.name]: {
          description: fnc.description,
          parameters: fnc.input_schema.properties,
          execute: async (args) => {
            let { function_results } = await functionHandler([{ ...fnc, input: args }], functions, keys, sendMessage);
            let [{ result: data }] = function_results;
            logger.info({ data }, `returning ${JSON.stringify(data)}`);
            return JSON.stringify(data);
          }
        }
        }), {})
    });






    const session = await lkAgent
      .start(ctx.room)
      .then((session) => session);
    session.on('input_speech_transcription_completed', ({ transcript }) => sendMessage({ user: transcript }));
    session.on('response_output_added', (newOutput) => logger.info({ newOutput }));
    session.on('response_output_done', output => sendMessage({agent: output?.content?.[0]?.text }));

    session.conversation.item.create({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Say "How can I help you today?"' }],
    });
    session.response.create();
  },
});
cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
