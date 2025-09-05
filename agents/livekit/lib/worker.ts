import dotenv from "dotenv";
import { RoomServiceClient } from "livekit-server-sdk";
import type { Room } from "livekit-server-sdk";
import { defineAgent, multimodal } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as ultravox from "../plugins/ultravox/src/index.js";
import logger from "../agent-lib/logger.js";

import * as functionHandlerModule from "../agent-lib/function-handler.js";
import { bridgeParticipant } from "./telephony.js";
import {
  getInstanceById,
  getInstanceByNumber,
  createCall,
  createTransactionLog,
} from "./api-client.js";

dotenv.config();

// logger will be imported dynamically

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

const events = [
  "input_speech_committed",
  "input_speech_started",
  "input_speech_stopped",
  "input_speech_transcription_completed",
  "input_speech_transcription_failed",
  "response_created",
  "response_done",
  "metrics_collected",
  "response_output_added",
  "function_call_started",
  "function_call_completed",
  "function_call_failed",
  "response_output_done",
  "response_content_added",
  "response_content_done",
  "response_text_delta",
  "response_text_done",
] as const;

const models = {
  ultravox,
  openai,
};

const roomService = new RoomServiceClient(
  LIVEKIT_URL!,
  LIVEKIT_API_KEY!,
  LIVEKIT_API_SECRET!
);

/**
 * Entry point for the Livekit agent, provides a function that takes a context object and starts the agent
 *
 *
 * @param ctx - The context object
 * @returns A promise that resolves when the agent is started
 */

export default defineAgent({
  entry: async (ctx: any) => {
    await ctx.connect();
    const room: Room = ctx.room as Room;

    // Local mutable state used across helpers
    let model: any = null;
    let bridgedParticipant: any = null;
    let wantHangup = false;

    try {
      const scenario = await getCallInfo(ctx, room);
      let {
        instance,
        agent,
        participant,
        callerId,
        calledId,
        aplisayId,
        callId,
        callMetadata,
        outboundCall,
        outboundInfo,
      } = scenario as any;

      const {
        userId,
        modelName,
        organisationId,
        options = {},
      } = (agent as any) || {};

      const {
        call,
        metadata,
        sendMessage,
        onHangup,
        onTransfer,
      } = await setupCallAndUtilities({
        ctx,
        room,
        instance,
        agent,
        callerId,
        calledId,
        aplisayId,
        callId,
        callMetadata,
        userId,
        organisationId,
        modelName,
        options,
        createModelRef: (create: () => any) => {
          model = create();
          return model;
        },
        setBridgedParticipant: (p: any) => (bridgedParticipant = p),
        requestHangup: () => (wantHangup = true),
      });

      if (outboundCall && outboundInfo && !participant) {
        try {
          logger.info(
            { callerId, calledId, instanceId: outboundInfo.instanceId, aplisayId },
            "bridging participant"
          );
          participant = await bridgeParticipant(
            room.name,
            outboundInfo.toNumber,
            outboundInfo.aplisayId,
            outboundInfo.fromNumber
          );
          if (!participant) {
            throw new Error("Outbound call failed to create participant");
          }
        } catch (err) {
          logger.error({ err }, "Outbound call failed");
          await createTransactionLog({
            userId,
            organisationId,
            callId: (call as any)?.id || callId,
            type: "call_failed",
            data: (err as Error).message,
            isFinal: true,
          });
          throw err;
        }
      }

      // Record the appropriate transaction at the top level
      await createTransactionLog({
        userId,
        organisationId,
        callId: (call as any)?.id || callId,
        type: "answer",
        data: instance.id,
        isFinal: true,
      });

      await runAgentWorker({
        ctx,
        room,
        agent,
        participant,
        callerId,
        calledId,
        modelName,
        metadata,
        sendMessage,
        call,
        onHangup,
        onTransfer,
        getModel: () => model,
        getBridgedParticipant: () => bridgedParticipant,
        wantHangup: () => wantHangup,
      });
    } catch (e) {
      logger.error(
        `error: closing room ${(e as Error).message} ${(e as Error).stack}`
      );
      room && room.name && (await roomService.deleteRoom(room.name));
    }
  },
});

// ---- Helpers ----

async function getCallInfo(ctx: any, room: Room) {
  const jobMetadata = (ctx.job.metadata && JSON.parse(ctx.job.metadata)) || {};
  let {
    callId,
    callerId,
    calledId,
    instanceId,
    aplisayId,
    outbound,
    callMetadata,
  } = jobMetadata || {};
  logger.info(
    { callerId, calledId, instanceId, aplisayId, outbound, jobMetadata },
    "new call"
  );

  let instance: any = null;
  let agent: any | null = null;
  let participant: any = null;
  let outboundCall = false;
  let outboundInfo: any = null;

  if (outbound) {
    if (!calledId || !callerId || !aplisayId || !instanceId) {
      logger.error({ ctx }, "missing metadata for outbound call");
      throw new Error("Missing metadata for outbound call");
    }
    instance = await getInstanceById(instanceId);
    if (!instance) {
      logger.error(
        { ctx },
        `No instance found for outbound call (${calledId} => ${callerId}) ${instanceId} was incorrect`
      );
      throw new Error("No instance found for outbound call");
    }
    // Do not perform side-effects here; signal to the caller to bridge
    outboundCall = true;
    outboundInfo = {
      toNumber: calledId,
      fromNumber: callerId,
      aplisayId,
      instanceId,
    };
  } else {
    participant = await ctx.waitForParticipant();
    let pInstanceId = participant.metadata;
    ({
      "sip.trunkPhoneNumber": calledId,
      "sip.phoneNumber": callerId,
      "sip.h.x-aplisay-trunk": aplisayId,
    } = participant?.attributes || {});
    calledId = calledId?.replace("+", "");
    callerId = callerId?.replace("+", "");
    if (pInstanceId) {
      instance = await getInstanceById(pInstanceId);
    } else if (calledId) {
      logger.info({ callerId, calledId, aplisayId }, "new Livekit inbound telephone call, looking up instance by number");
      const result = await getInstanceByNumber(calledId);
      instance = result;
      agent = result.Agent;
    }
    if (!instance) {
      logger.error(
        { participant },
        `no instance found for inbound call (${calledId} => ${callerId})`
      );
      throw new Error("No instance found");
    }
  }

  agent = agent || instance?.Agent || null;
  calledId = calledId || "WebRTC";
  callerId = callerId || "WebRTC";

  return {
    instance,
    agent,
    participant,
    callerId,
    calledId,
    aplisayId,
    callId,
    callMetadata,
    outboundCall,
    outboundInfo,
  };
}

async function setupCallAndUtilities({
  ctx,
  room,
  instance,
  agent,
  callerId,
  calledId,
  aplisayId,
  callId,
  callMetadata,
  userId,
  organisationId,
  modelName,
  options,
  createModelRef,
  setBridgedParticipant,
  requestHangup,
}: any) {
  const { fallback: { number: fallbackNumbers } = {} } = options || {};
  logger.info(
    { agent, instance, calledId, callerId, ctx, room },
    "new room instance"
  );

  const call = await createCall({
    id: callId,
    userId,
    organisationId,
    instanceId: instance.id,
    agentId: agent.id,
    platform: "livekit",
    platformCallId: room?.sid,
    calledId,
    callerId,
    modelName,
    options,
    metadata: {
      ...instance.metadata,
      ...(callMetadata || {}),
      aplisay: {
        callerId,
        calledId,
        fallbackNumbers,
        model: agent.modelName,
      },
    },
  });

  const { metadata } = call;
  metadata.aplisay = metadata.aplisay || {};
  metadata.aplisay.callId = call.id;

  const sendMessage = async (message: any) => {
    const entries = Object.entries(message);
    if (entries.length > 0) {
      const [type, data] = entries[0] as [string, any];
      ctx.room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify(message)),
        { reliable: true }
      );
      await createTransactionLog({
        userId,
        organisationId,
        callId: call.id,
        type,
        data: JSON.stringify(data),
        isFinal: true,
      });
    }
  };

  const onTransfer = async ({
    args,
    participant,
  }: any) => {
    if (!args.number.match(/^(\+44|44|0)[1237]\d{6,15}$/)) {
      logger.info({ args }, "invalid number");
      throw new Error(
        "Invalid number: only UK geographic and mobile numbers are supported currently as transfer targets"
      );
    }
    try {
      logger.info(
        {
          args,
          number: args.number,
          identity: participant.info["identity"],
          room,
          aplisayId,
        },
        "transfer participant"
      );
      const p = await bridgeParticipant(room.name, args.number, aplisayId, calledId);
      logger.info({ p }, "new participant created");
      const currentModel = createModelRef(() => null);
      if (currentModel && typeof currentModel.close === "function") {
        await currentModel.close();
      }
      setBridgedParticipant(p);
      return p;
    } catch (e) {
      console.log(
        {
          e,
          type: typeof e,
          message: (e as Error).message,
          stack: (e as Error).stack,
        },
        "transfer error"
      );
      logger.error({ e }, "error transferring participant");
      throw e;
    }
  };

  const onHangup = async () => {
    logger.info({}, "Hangup call requested");
    requestHangup();
  };

  return { call, metadata, sendMessage, onHangup, onTransfer };
}

async function runAgentWorker({
  ctx,
  room,
  agent,
  participant,
  callerId,
  calledId,
  modelName,
  metadata,
  sendMessage,
  call,
  onHangup,
  onTransfer,
  getModel,
  getBridgedParticipant,
  wantHangup,
}: any) {
  const plugin = modelName.match(/livekit:(\w+)\//)?.[1];
  const realtime = plugin && (models as any)[plugin]?.realtime;
  if (!realtime) {
    logger.error({ modelName, plugin, realtime, models }, "Unsupported model");
    throw new Error(`Unsupported model: ${modelName} ${plugin}`);
  }
  const model = getModel() ||
    new realtime.RealtimeModel({
      instructions: agent?.prompt || "You are a helpful assistant.",
      voice: agent?.options?.tts?.voice,
    });

  const { functions = [], keys = [] } = agent;
  const fncCtx =
    functions &&
    functions.reduce(
      (acc: any, fnc: any) => ({
        ...acc,
        [fnc.name]: {
          description: fnc.description,
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(fnc.input_schema.properties).map(
                ([key, value]: [string, any]) => [key, { ...value, required: undefined }]
              )
            ),
            required:
              Object.keys(fnc.input_schema.properties).filter(
                (key) => fnc.input_schema.properties[key].required
              ) || [],
          },
          execute: async (args: any) => {
            logger.debug({ name: fnc.name, args, fnc }, `Got function call ${fnc.name}`);
            let result = (await functionHandlerModule.functionHandler(
              [{ ...fnc, input: args }],
              functions,
              keys,
              sendMessage,
              metadata,
              { hangup: onHangup, transfer: (a: any) => onTransfer({ args: a, participant }) }
            )) as any;
            let { function_results } = result;
            let [{ result: data }] = function_results;
            logger.debug({ data }, `returning ${JSON.stringify(data)}`);
            return JSON.stringify(data);
          },
        },
      }),
      {}
    );

  logger.debug({ model, fncCtx }, "got fncCtx");
  const lkAgent = new multimodal.MultimodalAgent({ model, fncCtx });

  const session = await lkAgent.start(ctx.room).then((s: any) => s);
  events.forEach((event) => {
    session.on(event, (data: any) => {
      logger.debug({ event }, `Got event ${event}`);
    });
  });
  session.on("input_speech_transcription_completed", ({ transcript }: any) =>
    sendMessage({ user: transcript })
  );
  session.on("response_output_added", (newOutput: any) => logger.debug({ newOutput }));
  session.on("response_output_done", async (output: any) => {
    output?.content?.[0]?.audio && (output.content[0].audio = undefined);
    logger.debug({ output }, "response_output_done");
    sendMessage({ agent: output?.content?.[0]?.text });
    if (wantHangup()) {
      logger.info({ participant }, "Hangup call, closing realtime model");
      const currentModel = getModel();
      currentModel && (await currentModel.close());
      call.end();
      sendMessage({ hangup: `${calledId} => ${callerId}` });
      room && room.name && (await roomService.deleteRoom(room.name));
      logger.info({ participant }, "model closed");
    }
  });
  ctx.room.on("participantDisconnected", async (p: any) => {
    logger.info({ p, participant }, "participant disconnected");
    if (p.info.sid === (participant?.info?.sid || participant?.participantId)) {
      logger.info({ participant }, "Original participant disconnected, closing realtime model");
      const currentModel = getModel();
      currentModel && (await currentModel.close());
      call.end();
      sendMessage({ hangup: `${calledId} => ${callerId}` });
      room && room.name && (await roomService.deleteRoom(room.name));
      logger.info({ participant }, "model closed");
    }
    const bp = getBridgedParticipant();
    if (p.info.sid === bp?.participantId) {
      logger.info({ bp }, "Bridged participant disconnected, closing whole room");
      room && room.name && (await roomService.deleteRoom(room.name));
      logger.info({ bp }, "room closed");
      call.end();
      sendMessage({ hangup: `${calledId} => ${callerId}` });
    }
  });

  (session as any).response.create();
  call.start();
  sendMessage({ call: `${calledId} => ${callerId}` });
}
