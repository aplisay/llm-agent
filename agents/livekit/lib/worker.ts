// External dependencies
import dotenv from "dotenv";
import { RoomServiceClient } from "livekit-server-sdk";
import {
  type JobContext,
  defineAgent,
  getJobContext,
  voice,
  llm,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as google from "@livekit/agents-plugin-google";

// Should be contributed as a plugin to the Livekit Agents framework when stable,
// but for now
import * as ultravox from "../plugins/ultravox/src/index.js";

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
  getPhoneNumberByNumber,
  type PhoneNumberInfo,
  endCallById,
} from "./api-client.js";

// Types
import type { RemoteParticipant, Room } from "@livekit/rtc-node";
import { RoomEvent, TrackKind } from "@livekit/rtc-node";
import type { ParticipantInfo, SipParticipant } from "./types.js";
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

const realtimeModels = {
  openai,
  ultravox,
  google,
};

logger.debug({ realtimeModels }, "realtime models");

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
    const job = ctx.job;
    const room = job.room as unknown as Room;
    logger.debug({ ctx, job, room }, "new call");

    // Local mutable state used across helpers
    let session: voice.AgentSession | null = null;
    let model: voice.Agent | null = null;
    let bridgedParticipant: SipParticipant | null = null;
    let consultInProgress = false;
    let deafenedTrackSids: string[] = [];
    let mutedTrackSids: string[] = [];

    try {
      const scenario = await getCallInfo(ctx, room);

      let {
        instance,
        agent,
        participant,
        existingBridge,
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

      // If the room already has a bridged participant, we don't want to get involved in it
      //  but we must wait for it to finish before throwing an error or we will clear down the call.
      if (existingBridge) {
        let reason = await waitForExistingBridgedParticipant(
          ctx,
          room,
          existingBridge
        );
        throw new Error(`Bridged call already existed: ${reason}, ended call`);
      }

      const { userId, modelName, organisationId, options = {} } = agent;

      const {
        call,
        metadata,
        sendMessage,
        onHangup,
        onTransfer,
        checkForHangup,
        sessionRef,
        modelRef,
        holdParticipant,
        getActiveCall,
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
        modelRef: (create: voice.Agent | null): voice.Agent | null => {
          // Placeholder; actual model instance is set later in runAgentWorker
          create && (model = create);
          return model;
        },
        sessionRef: (
          create: voice.AgentSession | null
        ): voice.AgentSession | null => {
          create && (session = create);
          return session;
        },
        setBridgedParticipant: (p) => (bridgedParticipant = p),
        setConsultInProgress: (v: boolean) => (consultInProgress = v),
        getConsultInProgress: () => consultInProgress,

        requestHangup: () => {},
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
            outboundInfo.fromNumber,
            callerId || "unknown"
          );
          if (!participant) {
            throw new Error("Outbound call failed to create participant");
          }
        } catch (err) {
          logger.error({ err }, "Outbound call failed");
          sendMessage({
            call_failed: (err as Error).message.replace(/^twirp [^:]*: /, ""),
          });
          throw err;
        }
      }

      // Record the appropriate transaction at the top level
      sendMessage({ answer: callerId });

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
        modelRef,
        sessionRef,
        getBridgedParticipant: () => bridgedParticipant,
        setBridgedParticipant: (p) => (bridgedParticipant = p),
        checkForHangup,
        getConsultInProgress: () => consultInProgress,
        holdParticipant,
        getActiveCall,
      });
    } catch (e) {
      logger.error(
        `error: closing room ${(e as Error).message} ${(e as Error).stack}`
      );
      try {
        room && room.name && (await roomService.deleteRoom(room.name));
      } catch (e) {
        logger.error({ e }, "error deleting room");
      }
      try {
        await ctx.shutdown((e as Error).message);
      } catch (e) {
        logger.error({ e }, "error shutting down");
      }
      finally {
        process.exit(0);
      }
    }
  },
});

// ---- Helpers ----

async function getCallInfo(ctx: JobContext, room: Room): Promise<CallScenario> {
  const jobMetadata: JobMetadata =
    (ctx.job.metadata && JSON.parse(ctx.job.metadata)) || {};
  let {
    callId,
    callerId,
    calledId,
    identity,
    instanceId,
    aplisayId,
    outbound,
    callMetadata,
  } = jobMetadata || {};
  logger.info(
    {
      callerId,
      calledId,
      instanceId,
      aplisayId,
      outbound,
      jobMetadata,
      identity,
      room,
    },
    "getting call info"
  );

  let instance: Instance | null = null;
  let agent: Agent | null = null;
  let participant: ParticipantInfo | null = null;
  let bridgedParticipant: ParticipantInfo | null = null;
  let outboundCall = false;
  let outboundInfo: OutboundInfo | null = null;

  /*

  Because we throw every media scenario into the same agent dispatch, working out which agent and capabilities from 
  the scenario is a bit complex:
  Outbound calls: our manual dispatch puts the number we want to call, CID and agent instanceID in the Job Metadata
  Inbound WebRTC calls: again, we put the instanceId in the Job Metadata as `identity` when we dispatch the call
  Inbound SIP calls: the livekit SIP call routing and dispatch puts SIP header information in the participant attributes
                      we use this to extract the called number, and then lookup which agent instance we should answer with.
  
  */

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
    const participants = await roomService.listParticipants(room.name!);
    participant = participants.find(
      (p) => p.identity !== "sip-outbound-call"
    ) as ParticipantInfo;
    bridgedParticipant = participants.find(
      (p) => p.identity === "sip-outbound-call"
    ) as ParticipantInfo | null;
    logger.debug(
      { participants: participants.length, participant, bridgedParticipant },
      "have bridged participant?"
    );
    if (identity) {
      logger.debug({ identity }, "getting instance by identity");
      instance = await getInstanceById(identity);
      logger.debug({ instance }, "instance found?");
    } else if (room.name) {
      logger.debug(
        { participants, attributes: participant.attributes },
        "participants"
      );
      if (participant) {
        ({
          sipTrunkPhoneNumber: calledId,
          sipPhoneNumber: callerId,
          sipHXAplisayTrunk: aplisayId,
        } = participant.attributes);
      }

      calledId = calledId?.replace("+", "");
      callerId = callerId?.replace("+", "");

      logger.info(
        { callerId, calledId, aplisayId },
        "new Livekit inbound telephone call, looking up instance by number"
      );
      instance = calledId && (await getInstanceByNumber(calledId!));
    }
  }
  if (!instance) {
    logger.error(
      { participant },
      `no instance found for inbound call (${calledId} => ${callerId} or ${identity})`
    );
    throw new Error("No instance found");
  }

  agent = agent || instance?.Agent || null;
  calledId = calledId || "WebRTC";
  callerId = callerId || "WebRTC";

  return {
    instance: instance!,
    agent,
    participant,
    existingBridge: bridgedParticipant,
    callerId: callerId!,
    calledId: calledId!,
    aplisayId: aplisayId!,
    callId: callId!,
    callMetadata: callMetadata || {},
    outboundCall,
    outboundInfo,
  };
}


  /*
   * This is a hack to give a decent customer experience in the case where a previous agent worker has crashed,
   * but there were bridged conversations in progress in it's rooms.
   *
   * If we don't do this then we would fall through and create a new agent in the room which then starts talking to the customer
   * participants who are already in the room.
   *
   * Instead we stall all processing here until the participant disconnects, or 10 minutes passes.
   *
   * It is not a perfect solution, but it is a better experience for the customer.
   * 
   */
async function waitForExistingBridgedParticipant(
  ctx: JobContext,
  room: Room,
  bridgedParticipant: ParticipantInfo
): Promise<string> {

  if (!bridgedParticipant) {
    return "no bridged participant found";
  }
  // We have already bridged this call, so we need to get the bridged participant
  const roomInfo = await roomService.listRooms([room.name!]);
  const metadata = roomInfo[0]?.metadata as any;
  const bridgedCallId = JSON.parse(metadata)?.bridgedCallId || null;
  logger.info(
    { metadata, bridgedCallId, bridgedParticipant },
    "got existing bridged call room metadata"
  );
  ctx.connect();
  const disconnected = new Promise<string>((resolve, reject) => {
    ctx.room.on(
      RoomEvent.ParticipantDisconnected,
      async (p: RemoteParticipant) => {
        logger.info({ p }, "participant of already bridged call disconnected");
        resolve("participant of already bridged call disconnected");
      }
    );
    setTimeout(() => {
      resolve(
        "Participant of already bridged call did not disconnect after 10 minutes"
      );
    }, 10 * 60 * 1000);
  });
  let reason = await disconnected;
  bridgedCallId &&
    (await endCallById(
      bridgedCallId,
      `Bridged call already existed: ${reason}`
    ));
  return reason;
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
  modelRef,
  sessionRef,
  setBridgedParticipant,
  setConsultInProgress,
  getConsultInProgress,
  requestHangup,
}: SetupCallParams) {
  const { fallback: { number: fallbackNumbers } = {} } = options || {};
  logger.info(
    { agent, instance, aplisayId, calledId, callerId, ctx, room },
    "new room instance"
  );

  let wantHangup = false;
  let currentBridged: SipParticipant | null = null;
  let bridgedCallRecord: Call | null = null;

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

  // Array to batch transaction logs when streamLog is false
  const batchedTransactionLogs: Array<{
    userId: string;
    organisationId: string;
    callId: string;
    type: string;
    data?: string;
    isFinal?: boolean;
    createdAt?: Date;
  }> = [];

  const sendMessage = async (message: MessageData) => {
    try {
      const entries = Object.entries(message);
      if (entries.length > 0) {
        const [type, data] = entries[0] as [string, unknown];
        ctx.room.localParticipant?.publishData(
          new TextEncoder().encode(JSON.stringify(message)),
          { reliable: true }
        );

        if (type === "status") {
          return;
        }

        // Capture the timestamp when the log was created
        const createdAt = new Date();

        const transactionLogData = {
          userId,
          organisationId,
          callId: call.id,
          type,
          data: JSON.stringify(data),
          isFinal: true,
          createdAt,
        };

        // If streamLog is enabled, push immediately; otherwise batch for end call
        if (instance.streamLog === true) {
          await createTransactionLog(transactionLogData);
        } else {
          batchedTransactionLogs.push(transactionLogData);
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error(
        { error, message: error.message, stack: error.stack },
        "error sending message"
      );
    }
  };

  // This is a bit of a hack, what we really want to do is move the caller into
  //  an isolated "hold" room, but the agent framework gets upset when we remove it
  //  from the main room.
  const holdParticipant = async (identity: string, hold: boolean) => {
    const participants = await roomService.listParticipants(room.name!);
    const targetParticipant = participants.find((p) => p.sid === identity);
    logger.debug({ identity, participants, hold }, "holding participant");
    try {
      // unsubscribe from all tracks when holding; resubscribe to none, agent will still hear callee
      await roomService.updateSubscriptions(
        room.name!,
        targetParticipant?.identity!,
        [],
        !hold
      );
      logger.debug(
        { identity: targetParticipant?.sid, hold },
        "updated subscriptions for hold"
      );
    } catch (e: any) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error(
        {
          error,
          message: error.message,
          stack: error.stack,
          identity,
          roomName: room.name,
          hold,
        },
        "failed to update subscriptions"
      );
    }
  };

  const onTransfer = async ({
    args,
    participant,
  }: {
    args: TransferArgs;
    participant: ParticipantInfo;
  }) => {
    if (!args.number.match(/^(\+44|44|0)[1237]\d{6,15}$/)) {
      logger.info({ args }, "invalid number");
      throw new Error(
        "Invalid number: only UK geographic and mobile numbers are supported currently as transfer targets"
      );
    }
    try {
      const operation = args.operation || "blind";
      let effectiveCallerId = args.callerId || calledId;
      const session = sessionRef(null);

      // Validate overridden callerId if provided
      if (args.callerId) {
        const pn: PhoneNumberInfo | null = await getPhoneNumberByNumber(
          args.callerId
        );
        if (!pn) {
          throw new Error("Invalid callerId: number not found");
        }
        if (pn.organisationId && pn.organisationId !== agent.organisationId) {
          throw new Error(
            "Invalid callerId: number not owned by this organisation"
          );
        }
        if (!pn.outbound) {
          throw new Error(
            "Invalid callerId: outbound not enabled on this number"
          );
        }
        // If inbound has aplisayId, require match
        if (aplisayId) {
          if (pn.aplisayId && pn.aplisayId !== aplisayId) {
            throw new Error("Invalid callerId: aplisayId mismatch");
          }
        } else {
          // WebRTC: adopt aplisayId from outbound number if available
          pn.aplisayId && (aplisayId = pn.aplisayId);
        }
        effectiveCallerId = pn.number;
      }
      logger.info(
        {
          args,
          number: args.number,
          operation,
          identity: participant?.sid,
          room,
          aplisayId,
          calledId,
          effectiveCallerId,
        },
        "transfer participant"
      );

      // helper to end current call and create/start bridged call record
      const finaliseBridgedCall = async () => {
        // Close down the model for the agent leg
        session?.llm && (session.llm as llm.RealtimeModel)?.close();
        try {
          const originalCallId = call.id;
          bridgedCallRecord = await createCall({
            parentId: originalCallId,
            userId,
            organisationId,
            instanceId: instance.id,
            agentId: agent.id,
            platform: "livekit",
            platformCallId: room?.name,
            calledId,
            callerId,
            modelName: "telephony:bridged-call",
            options,
            metadata: { ...call.metadata },
          });
          if (bridgedCallRecord) {
            await call.end(
              `Agent left call, new bridged call: ${bridgedCallRecord.id}`
            );
            bridgedCallRecord &&
              (await roomService.updateRoomMetadata(
                room.name!,
                JSON.stringify({ bridgedCallId: bridgedCallRecord.id })
              ));
            await bridgedCallRecord.start();
          }
        } catch (e) {
          logger.error({ e }, "failed to create bridged call record");
        }
      };

      switch (operation) {
        case "blind":
        default:
          const p = await bridgeParticipant(
            room.name!,
            args.number,
            aplisayId!,
            effectiveCallerId,
            callerId || "unknown"
          );
          logger.info({ p }, "new participant created (blind)");
          setBridgedParticipant(p);
          await finaliseBridgedCall();
          return {
            status: "OK",
            detail: `transfer completed, session is now closed`,
          };
          break;
        case "consult_start":
          try {
            const p = await bridgeParticipant(
              room.name!,
              args.number,
              aplisayId!,
              effectiveCallerId,
              callerId || "unknown"
            );
            logger.debug({ p }, "bridged participant completed");
            const rbp = await ctx.waitForParticipant(p.participantIdentity);
            logger.debug(
              { p, rbp },
              "bridged participant, subscribing to tracks"
            );
            rbp.trackPublications?.forEach(async (t) => {
              if (t.kind === TrackKind.KIND_AUDIO) {
                logger.debug({ t }, "subscribing agent to track");
                await t.setSubscribed(true);
                logger.debug({ t }, "track subscribed");
              }
            });
            logger.info({ p }, "new participant created (consult_start)");
            setBridgedParticipant(p);
            currentBridged = p;
            await holdParticipant(participant.sid!, true);
            setConsultInProgress(true);
            return {
              status: "OK",
              detail: `Consult transfer started to the agent, you are now talking to the agent not the original caller!`,
            };
          } catch (e: any) {
            let error = e as Error;
            if (!(e instanceof Error)) {
              error = new Error(e);
            }
            logger.error({ e }, "failed to initiate consult transfer");
            return {
              status: "ERROR",
              detail: `Failed to initiate consult transfer`,
              error: error,
            };
          }
          break;
        case "consult_finalise":
          if (!getConsultInProgress() || !currentBridged) {
            throw new Error("No consult transfer in progress to finalise");
          }
          await finaliseBridgedCall();
          await holdParticipant(participant.sid!, false);
          return {
            status: "OK",
            detail: `consult transfer completed, session is now closed`,
          };
          break;
        case "consult_reject":
          const bp = currentBridged;
          logger.debug(
            { roomName: room.name, identity: bp?.participantId },
            "consult_reject"
          );
          if (bp && room?.name && bp.participantId) {
            try {
              // Use SIP hangup to ensure the outbound call is properly torn down
              await roomService.removeParticipant(
                room.name,
                bp.participantIdentity
              );
              await holdParticipant(participant.sid!, false);
              logger.debug({ bp }, "removed bridged participant");
            } catch (e) {
              logger.error(
                { e, bp, roomName: room.name, room },
                "failed to remove bridged participant"
              );
              roomService.listParticipants(room.name).then((participants) => {
                logger.debug(
                  { participants },
                  "participants after failed remove"
                );
              });
            }
            setBridgedParticipant(null as unknown as SipParticipant);
            currentBridged = null;
          }
          setConsultInProgress(false);
          return {
            status: "OK",
            detail: `consult transfer rejected, session is now closed`,
          };
          break;
      }
    } catch (e: any) {
      let error = e as Error;
      if (!(e instanceof Error)) {
        logger.error(
          { e: String(e) },
          `Expected error, got ${e} (${typeof e})`
        );
        error = new Error(e);
      }
      logger.error(
        { error, message: error.message, stack: error.stack },
        `error transferring participant`
      );
      throw error;
    }
  };

  const checkForHangup = () => {
    return wantHangup;
  };

  async function onHangup() {
    wantHangup = true;
  }

  // Attach batched transaction logs to the call object for access during end()
  (call as any).batchedTransactionLogs = batchedTransactionLogs;

  return {
    call,
    metadata,
    sendMessage,
    onHangup,
    onTransfer,
    checkForHangup,
    modelRef,
    sessionRef,
    // expose helper to check the currently active call for logging
    getActiveCall: () => bridgedCallRecord || call,
    holdParticipant,
  };
}

/**
 * Creates tools for the agent based on the agent's functions configuration
 */
function createTools({
  agent,
  room,
  participant,
  sendMessage,
  metadata,
  onHangup,
  onTransfer,
}: {
  agent: Agent;
  room: Room;
  participant: ParticipantInfo | null;
  sendMessage: (message: MessageData) => Promise<void>;
  metadata: CallMetadata;
  onHangup: () => Promise<void>;
  onTransfer: ({
    args,
    participant,
  }: {
    args: TransferArgs;
    participant: ParticipantInfo;
  }) => Promise<ParticipantInfo>;
}): llm.ToolContext {
  const { functions = [], keys = [] } = agent;

  return (
    functions &&
    (functions.reduce(
      (acc: llm.ToolContext, fnc: AgentFunction) => ({
        ...acc,
        [fnc.name]: llm.tool({
          description: fnc.description,
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(fnc.input_schema.properties)
                .filter(([, value]) => value.source === "generated")
                .map(([key, value]: [string, any]) => [
                  key,
                  { ...value, required: undefined },
                ])
            ),
            required:
              Object.keys(fnc.input_schema.properties).filter(
                (key) => fnc.input_schema.properties[key].required
              ) || [],
          },
          execute: async (args: unknown) => {
            try {
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
                  hangup: () => onHangup(),
                  transfer: async (a: TransferArgs) =>
                    await onTransfer({ args: a, participant: participant! }),
                }
              )) as FunctionResult;
              let { function_results } = result;
              let [{ result: data }] = function_results;
              logger.debug(
                { data },
                `function execute returning ${JSON.stringify(data)}`
              );
              return JSON.stringify(data);
            } catch (e) {
              logger.error({ e }, "error executing function");
              throw e;
            }
          },
        }),
      }),
      {}
    ) as llm.ToolContext)
  );
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
  getBridgedParticipant,
  setBridgedParticipant,
  checkForHangup,
  sessionRef,
  modelRef,
  getConsultInProgress,
  holdParticipant,
  getActiveCall,
}: RunAgentWorkerParams) {
  const plugin = modelName.match(/livekit:(\w+)\//)?.[1];
  let timerId: NodeJS.Timeout | null = null;
  const realtime =
    plugin && (realtimeModels as Record<string, any>)[plugin]?.realtime;
  let initialMessage: string | null = "say hello";
  if (!realtime) {
    logger.error(
      { modelName, plugin, realtime, realtimeModels },
      "Unsupported model"
    );
    throw new Error(`Unsupported model: ${modelName} ${plugin}`);
  }
  logger.debug(
    { realtime, realtimeModels, openAI: openai.realtime },
    "got realtime"
  );

  const tools = createTools({
    agent,
    room: room!,
    participant,
    sendMessage,
    metadata,
    onHangup,
    onTransfer,
  });

  const model = new voice.Agent({
    instructions: agent?.prompt || "You are a helpful assistant.",
    tools,
  });
  modelRef(model);
  const maxDurationString: string = agent?.options?.maxDuration || "305s";
  const maxDuration =
    1000 * parseInt(maxDurationString.match(/(\d+)s/)?.[1] || "305");

  let session: voice.AgentSession | null = null;

  try {
    session = new voice.AgentSession({
      llm: new realtime.RealtimeModel({
        voice: agent?.options?.tts?.voice,
        maxDuration: maxDurationString,
        instructions: agent?.prompt || "You are a helpful assistant.",
      }),
    });
    sessionRef(session);

    // Listen on all the things for now (debug)
    Object.keys(voice.AgentSessionEventTypes).forEach((event) => {
      session?.on(
        voice.AgentSessionEventTypes[
          event as keyof typeof voice.AgentSessionEventTypes
        ],
        (data: unknown) => {
          logger.debug({ data }, `Got event ${event}`);
        }
      );
    });

    // Listen on the user input transcribed event
    session.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      ({ item: { type, role, content } }: voice.ConversationItemAddedEvent) => {
        if (type === "message" && getConsultInProgress() === false) {
          const text = content.join("");
          if (role !== "user" || text !== initialMessage) {
            sendMessage({
              [role === "user" ? "user" : "agent"]: text,
            });
          }
        }
      }
    );

    session.on(
      voice.AgentSessionEventTypes.AgentStateChanged,
      (ev: voice.AgentStateChangedEvent) => {
        sendMessage({ status: ev.newState });
        if (ev.newState === "listening" && checkForHangup() && room.name) {
          logger.debug({ room }, "room close inititiated");
          getActiveCall().end("agent initiated hangup");
          roomService.deleteRoom(room.name);
        }
      }
    );

    session.on(voice.AgentSessionEventTypes.Error, (ev: voice.ErrorEvent) => {
      logger.error({ ev }, "error");
    });

    session.on(voice.AgentSessionEventTypes.Close, (ev: voice.CloseEvent) => {
      logger.info({ ev }, "session closed");
      roomService.deleteRoom(room.name);
      getActiveCall().end("session closed");
    });

    //
    await session.start({
      room: ctx.room,
      agent: model,
    });

    await ctx.connect();

    logger.debug({ room }, "connected got room");

    ctx.room.on(
      RoomEvent.ParticipantDisconnected,
      async (p: RemoteParticipant) => {
        const bp = getBridgedParticipant();
        logger.debug(
          { p, bridgedParticipant: bp, participant },
          "participant disconnected"
        );
        if (bp?.participantId === p?.info?.sid) {
          if (getConsultInProgress()) {
            logger.debug(
              "consult callee disconnected, treating as consult_reject"
            );
            // Unhold original participant
            try {
              const participants = await roomService.listParticipants(
                room.name
              );
              const original = participants.find(
                (pi) => pi.sid !== bp?.participantId
              );
              if (original?.sid) {
                await holdParticipant(original.sid, false);
              }
            } catch (e) {
              logger.error(
                { e },
                "failed to unhold participant on callee hangup"
              );
            }
            // reset consult state
            // remove bridged participant if still present in server state (it should be gone already)
            try {
              bp?.participantIdentity &&
                (await roomService.removeParticipant(
                  room.name,
                  bp.participantId
                ));
            } catch {}
            // underlying setters live in setup scope; remaining state will be reset on next transfer call
          } else {
            logger.debug("bridge participant disconnected, shutting down");
            await cleanupAndClose("bridged participant disconnected");
            setBridgedParticipant(null as unknown as SipParticipant);
          }
        } else if (p.info?.sid === participant?.sid) {
          logger.debug("participant disconnected, shutting down");
          await cleanupAndClose("original participant disconnected", true);
        }
      }
    );

    // Hard stop timeout on the session which is 5 seconds after the AI agent maxDuration
    // This is to ensure that the session is closed and the room is deleted even if the
    // AI agent fails to close the session (e.g OpenAI has no maxDuration parameter)
    timerId = setTimeout(() => {
      // If the bridged participant is present, we have transferred out, ignore the session timeout.
      if (getBridgedParticipant()) {
        logger.debug("bridged participant present, ignoring session timeout");
        return;
      }
      logger.debug("session timeout, generating reply");
      try {
        session?.generateReply({ userInput: "The session has timed out." });
      } catch (e) {
        logger.info({ e }, "error generating timeout reply");
      }
      // 10 secs later, tear everything down
      setTimeout(() => {
        try {
          cleanupAndClose("session timeout");
        } catch (e) {
          logger.info({ e }, "error tearing down call on timeout");
        }
      }, 10 * 1000);
    }, maxDuration + 5 * 1000);

    logger.debug("session started, generating reply");
    session.generateReply({ userInput: initialMessage });
    await call.start();
    sendMessage({ call: `${callerId} => ${calledId}` });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error(
      { error, message: error.message, stack: error.stack },
      "error running agent worker"
    );
    await cleanupAndClose("UNCAUGHT ERROR: running agent worker");
  }

  async function cleanupAndClose(reason: string, logEndCall: boolean = false) {
    try {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      session && session.close();
      try {
        await getActiveCall().end(reason);
      } catch (e) {
        logger.error({ e }, "error ending call");
      }
      try {
        await roomService.deleteRoom(room.name);
      } catch (e) {
        logger.error({ e }, "error deleting room");
      }
      await ctx.shutdown(reason);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.info(
        { message: error.message, error },
        "error cleaning up and closing"
      );
    } finally {
      process.exit(0);
    }
  }
}
