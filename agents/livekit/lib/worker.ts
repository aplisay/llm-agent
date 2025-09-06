// External dependencies
import dotenv from "dotenv";
import { RoomServiceClient } from "livekit-server-sdk";
import { type JobContext, defineAgent, voice, llm } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";

// Internal modules
import logger from "../agent-lib/logger.js";
import * as functionHandlerModule from "../agent-lib/function-handler.js";
import { bridgeParticipant } from "./telephony.js";
import {
  getInstanceById,
  getInstanceByNumber,
  createCall,
  createTransactionLog,
  type Instance,
  type Agent,
  type AgentFunction,
  type Call,
  type CallMetadata,
  type OutboundInfo,
} from "./api-client.js";

// Types
import type { Room, RemoteParticipant } from "@livekit/rtc-node";
import type {
  CallScenario,
  JobMetadata,
  SetupCallParams,
  RunAgentWorkerParams,
  TransferArgs,
  MessageData,
  FunctionResult,
} from "./types.js";

dotenv.config();
const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

const models = {
  openai,
};

const roomService = new RoomServiceClient(
  LIVEKIT_URL!,
  LIVEKIT_API_KEY!,
  LIVEKIT_API_SECRET!
);

logger.debug({ events: voice.AgentSessionEventTypes }, "events");

/**
 * Entry point for the Livekit agent, provides a function that takes a context object and starts the agent
 *
 *
 * @param ctx - The context object
 * @returns A promise that resolves when the agent is started
 */

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const room = ctx.room;

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
      } = scenario;

      if (!agent) {
        throw new Error("Agent is required but not found");
      }

      const { userId, modelName, organisationId, options = {} } = agent;

      const { call, metadata, sendMessage, onHangup, onTransfer } =
        await setupCallAndUtilities({
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
          setBridgedParticipant: (p) => (bridgedParticipant = p),
          requestHangup: () => (wantHangup = true),
        });

      if (outboundCall && outboundInfo && !participant) {
        try {
          logger.info(
            {
              room,
              callerId,
              calledId,
              instanceId: outboundInfo.instanceId,
              aplisayId,
            },
            "bridging participant"
          );
          participant = await bridgeParticipant(
            room.name!,
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
            callId: (call as Call)?.id || callId,
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
        callId: (call as Call)?.id || callId,
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

async function getCallInfo(ctx: JobContext, room: Room): Promise<CallScenario> {
  const jobMetadata: JobMetadata = (ctx.job.metadata && JSON.parse(ctx.job.metadata)) || {};
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

  let instance: Instance | null = null;
  let agent: Agent | null = null;
  let participant: RemoteParticipant | null = null;
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
    // Get participant from room if not already set
    if (!participant && room.numParticipants > 0) {
      // For now, we'll set participant to null and handle it later
      participant = await ctx.waitForParticipant();
    }
    let pInstanceId = participant?.metadata;
    if (participant && 'attributes' in participant) {
      const participantWithAttrs = participant as any;
      if (participantWithAttrs.attributes) {
        ({
          "sip.trunkPhoneNumber": calledId,
          "sip.phoneNumber": callerId,
          "sip.h.x-aplisay-trunk": aplisayId,
        } = participantWithAttrs.attributes);
      }
    }
    calledId = calledId?.replace("+", "");
    callerId = callerId?.replace("+", "");
    if (pInstanceId) {
      instance = await getInstanceById(pInstanceId);
    } else if (calledId) {
      logger.info(
        { callerId, calledId, aplisayId },
        "new Livekit inbound telephone call, looking up instance by number"
      );
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
    instance: instance!,
    agent,
    participant,
    callerId: calledId!,
    calledId: callerId!,
    aplisayId: aplisayId!,
    callId: callId!,
    callMetadata: callMetadata || {},
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
}: SetupCallParams) {
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
    platformCallId: room?.name,
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

  const sendMessage = async (message: MessageData) => {
    const entries = Object.entries(message);
    if (entries.length > 0) {
      const [type, data] = entries[0] as [string, any];
      ctx.room.localParticipant?.publishData(
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

  const onTransfer = async ({ args, participant }: { args: TransferArgs; participant: RemoteParticipant }) => {
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
          identity: participant.info?.["identity"],
          room,
          aplisayId,
        },
        "transfer participant"
      );
      const p = await bridgeParticipant(
        room.name!,
        args.number,
        aplisayId!,
        calledId
      );
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

/**
 * Creates tools for the agent based on the agent's functions configuration
 */
function createTools({
  agent,
  participant,
  sendMessage,
  metadata,
  onHangup,
  onTransfer,
}: {
  agent: Agent;
  participant: RemoteParticipant | null;
  sendMessage: (message: MessageData) => Promise<void>;
  metadata: CallMetadata;
  onHangup: () => Promise<void>;
  onTransfer: ({ args, participant }: { args: TransferArgs; participant: RemoteParticipant }) => Promise<any>;
}): llm.ToolContext {
  const { functions = [], keys = [] } = agent;
  
  return functions &&
    functions.reduce(
      (acc: llm.ToolContext, fnc: AgentFunction) => ({
        ...acc,
        [fnc.name]: llm.tool({
          description: fnc.description,
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(fnc.input_schema.properties).map(
                ([key, value]: [string, any]) => [
                  key,
                  { ...value, required: undefined },
                ]
              )
            ),
            required:
              Object.keys(fnc.input_schema.properties).filter(
                (key) => fnc.input_schema.properties[key].required
              ) || [],
          },
          execute: async (args: any) => {
            logger.debug(
              { name: fnc.name, args, fnc },
              `Got function call ${fnc.name}`
            );
            let result = (await functionHandlerModule.functionHandler(
              [{ ...fnc, input: args }],
              functions,
              keys,
              sendMessage,
              metadata,
              {
                hangup: onHangup,
                transfer: (a: any) => onTransfer({ args: a, participant: participant! }),
              }
            )) as FunctionResult;
            let { function_results } = result;
            let [{ result: data }] = function_results;
            logger.debug({ data }, `returning ${JSON.stringify(data)}`);
            return JSON.stringify(data);
          },
        }),
      }),
      {}
    ) as llm.ToolContext;
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
}: RunAgentWorkerParams) {
  const plugin = modelName.match(/livekit:(\w+)\//)?.[1];
  const realtime = plugin && (models as any)[plugin]?.realtime;
  if (!realtime) {
    logger.error({ modelName, plugin, realtime, models }, "Unsupported model");
    throw new Error(`Unsupported model: ${modelName} ${plugin}`);
  }
  logger.debug({ realtime, models, openAI: openai.realtime }, "got realtime");

  const tools = createTools({
    agent,
    participant,
    sendMessage,
    metadata,
    onHangup,
    onTransfer,
  });
  
  const model = new voice.Agent({
    instructions: agent?.prompt || "You are a helpful assistant.",
    tools
  });


  const session = new voice.AgentSession({
    llm: new realtime.RealtimeModel({
      voice: agent?.options?.tts?.voice,
    }),
  });

  // Listen on all the things for now (debug)
  Object.keys(voice.AgentSessionEventTypes).forEach((event) => {
    session.on(
      voice.AgentSessionEventTypes[
        event as keyof typeof voice.AgentSessionEventTypes
      ],
      (data: any) => {
        logger.debug({ data }, `Got event ${event}`);
      }
    );
  });

  // Listen on the user input transcribed event
  session.on(
    voice.AgentSessionEventTypes.UserInputTranscribed,
    ({ transcript }: voice.UserInputTranscribedEvent) =>
      sendMessage({ user: transcript })
  );

  //
  await session.start({
    room: ctx.room,
    agent: model,
  });

  // Hack to workaround 
  logger.debug("session started, generating reply");
  session.generateReply({ userInput: "say hello" });
  call.start();
  sendMessage({ call: `${calledId} => ${callerId}` });
}
