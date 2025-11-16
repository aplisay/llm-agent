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
  getPhoneEndpointById,
  getPhoneEndpointByNumber,
  getPhoneNumberByNumber,
  type PhoneNumberInfo,
  type PhoneRegistrationInfo,
  type TrunkInfo,
} from "./api-client.js";
import {
  handleTransfer,
  type TransferContext,
  destroyInProgressTransfer,
} from "./transfer-handler.js";

// Types
import type {
  RemoteParticipant,
  Room,
} from "@livekit/rtc-node";
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
    logger.info({ ctx, job, room }, "new call");

    // Local mutable state used across helpers
    let session: voice.AgentSession | null = null;
    let model: voice.Agent | null = null;
    let bridgedParticipant: SipParticipant | null = null;
    let consultInProgress = false;
    let deafenedTrackSids: string[] = [];
    let mutedTrackSids: string[] = [];
    let b2buaIp: string | null = null;
    let b2buaTransport: string | null = null;
    // Capture B2BUA gateway values for use in onTransfer closure
    let capturedB2buaIp: string | null = null;
    let capturedB2buaTransport: string | null = null;
    // Function to end transfer activity - will be set by setupCallAndUtilities
    let endTransferActivityIfNeeded: ((reason: string) => Promise<void>) | null = null;

    try {
      const scenario = await getCallInfo(ctx, room);
      logger.info({ scenario }, "scenario");

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
        registrationOriginated,
        trunkInfo,
        registrationRegistrar,
        registrationTransport,
        registrationEndpointId,
        b2buaGatewayIp = null,
        b2buaGatewayTransport = null,
      } = scenario;

      // Store B2BUA gateway info for use in onTransfer closure
      b2buaIp = b2buaGatewayIp || null;
      b2buaTransport = b2buaGatewayTransport || null;
      // Capture values for onTransfer closure
      capturedB2buaIp = b2buaIp;
      capturedB2buaTransport = b2buaTransport;

      if (!agent) {
        throw new Error("Agent is required but not found");
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
        endTransferActivityIfNeeded: endTransferActivityFn,
        getTransferState,
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
        registrationOriginated,
        trunkInfo,
        registrationRegistrar,
        registrationTransport,
        registrationEndpointId,
        b2buaGatewayIp: capturedB2buaIp,
        b2buaGatewayTransport: capturedB2buaTransport,
        requestHangup: () => {},
        participant: participant,
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
            callerId
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
        checkForHangup,
        getConsultInProgress: () => consultInProgress,
        holdParticipant,
        getActiveCall,
        endTransferActivityIfNeeded: endTransferActivityFn,
        getTransferState,
      });
      // Store the function in outer scope for use in catch block
      endTransferActivityIfNeeded = endTransferActivityFn;
    } catch (e) {
      logger.error(
        `error: closing room ${(e as Error).message} ${(e as Error).stack}`
      );
      // End transfer activity if in progress
      // Note: endTransferActivityIfNeeded may not be available if error occurred before setupCallAndUtilities completed
      if (endTransferActivityIfNeeded) {
        try {
          await endTransferActivityIfNeeded("Error occurred");
        } catch (transferError) {
          logger.error({ transferError }, "error ending transfer activity during error cleanup");
        }
      }
      room && room.name && (await roomService.deleteRoom(room.name));
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

  let phoneRegistration: string | null = null;
  let instance: Instance | null = null;
  let agent: Agent | null = null;
  let participant: ParticipantInfo | null = null;
  let outboundCall = false;
  let outboundInfo: OutboundInfo | null = null;
  let registrationOriginated = false;
  let trunkInfo: TrunkInfo | null = null;
  let registrationRegistrar: string | null = null;
  let registrationTransport: string | null = null;
  let registrationEndpointId: string | null = null;
  let b2buaGatewayIp: string | null = null;
  let b2buaGatewayTransport: string | null = null;

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
    logger.info({ room }, "room name getting participants");
    const participants = await roomService.listParticipants(room.name!);
    logger.info({ participants }, "participants");
    participant = participants[0] as ParticipantInfo;
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
        const {
          sipTrunkPhoneNumber: calledIdAttr,
          sipPhoneNumber: callerIdAttr,
          sipHXAplisayTrunk: aplisayIdAttr,
          sipHXAplisayPhoneregistration: phoneRegistrationAttr,
          sipHostname: sipHostnameAttr,
          sipHXLkRealIp: b2buaGatewayIpAttr,
          sipHXLkTransport: b2buaGatewayTransportAttr,
        } = participant.attributes || {};
        
        calledId = calledIdAttr;
        callerId = callerIdAttr;
        aplisayId = aplisayIdAttr;
        phoneRegistration = phoneRegistrationAttr;
        
        // Store registration endpoint ID for transfer operations
        if (phoneRegistration) {
          registrationEndpointId = phoneRegistration;
        }
        
        // Store B2BUA gateway information for routing outbound calls
        if (b2buaGatewayIpAttr) {
          b2buaGatewayIp = b2buaGatewayIpAttr;
          b2buaGatewayTransport = b2buaGatewayTransportAttr || null;
          logger.info({ b2buaGatewayIp, b2buaGatewayTransport }, "Extracted B2BUA gateway information from participant attributes");
        }
        
        // If we have sipHostname but no registrar from endpoint lookup, use sipHostname
        // (sipHostname is the registrar hostname from the inbound call)
        if (phoneRegistration && sipHostnameAttr && !registrationRegistrar) {
          registrationRegistrar = sipHostnameAttr;
          logger.info({ sipHostname: sipHostnameAttr }, "Using sipHostname as registrar from participant attributes");
        }
      }

      calledId = calledId?.replace("+", "");
      callerId = callerId?.replace("+", "");
      
      // If we have a phoneRegistration ID, lookup the phone endpoint by ID
      // Otherwise, use the calledId (phone number) to lookup by number
      if (phoneRegistration) {
        registrationOriginated = true;
        logger.info(
          { callerId, phoneRegistration, aplisayId },
          "new Livekit inbound telephone call, looking up phone endpoint by registration ID"
        );
        const phoneEndpoint = await getPhoneEndpointById(phoneRegistration);
        if (phoneEndpoint && 'id' in phoneEndpoint) {
          const regInfo = phoneEndpoint as PhoneRegistrationInfo;
          logger.info({ phoneEndpoint: regInfo }, "found phone registration endpoint");
          // Store registrar and transport for transfer operations
          registrationRegistrar = regInfo.registrar || null;
          registrationTransport = regInfo.options?.transport || null;
          // PhoneRegistration now has instanceId, so we can lookup the instance
          if (regInfo.instanceId) {
            instance = await getInstanceById(regInfo.instanceId);
            logger.info({ instanceId: regInfo.instanceId, instance }, "found instance from registration instanceId");
          }
        }
      } else if (calledId) {
        logger.info(
          { callerId, calledId, aplisayId },
          "new Livekit inbound telephone call, looking up phone endpoint by number"
        );
        // Pass trunkId (aplisayId) for validation - will throw error if mismatch
        const phoneEndpoint = await getPhoneEndpointByNumber(calledId, aplisayId);
        if (phoneEndpoint && 'number' in phoneEndpoint) {
          const numInfo = phoneEndpoint as PhoneNumberInfo;
          logger.info({ phoneEndpoint: numInfo }, "found phone number endpoint");
          // Store trunk info if available
          if (numInfo.trunk) {
            trunkInfo = numInfo.trunk;
            logger.info({ trunkInfo }, "trunk info retrieved from phone endpoint");
          }
          // PhoneNumber has instanceId, so we can lookup the instance
          if (numInfo.instanceId) {
            instance = await getInstanceById(numInfo.instanceId);
          } else {
            // Fallback to old behavior
            instance = await getInstanceByNumber(calledId);
          }
        } else {
          // Fallback: try direct instance lookup by number
          instance = await getInstanceByNumber(calledId);
        }
      }
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
    callerId: callerId!,
    calledId: calledId!,
    aplisayId: aplisayId!,
    callId: callId!,
    callMetadata: callMetadata || {},
    outboundCall,
    outboundInfo,
    registrationOriginated,
    trunkInfo,
    registrationRegistrar,
    registrationTransport,
    registrationEndpointId,
    b2buaGatewayIp,
    b2buaGatewayTransport,
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
  modelRef,
  sessionRef,
  setBridgedParticipant,
  setConsultInProgress,
  getConsultInProgress,
  registrationOriginated,
  trunkInfo,
  registrationRegistrar,
  registrationTransport,
  registrationEndpointId,
  b2buaGatewayIp,
  b2buaGatewayTransport,
  requestHangup,
  participant: originalParticipant,
}: SetupCallParams & { participant?: ParticipantInfo | null }) {
  const { fallback: { number: fallbackNumbers } = {} } = options || {};
  logger.info(
    { agent, instance, aplisayId, calledId, callerId, ctx, room },
    "new room instance"
  );

  let wantHangup = false;
  let currentBridged: SipParticipant | null = null;
  let bridgedCallRecord: Call | null = null;
  
  // Consultation room state for warm transfers
  let consultRoomName: string | null = null;
  let transferSession: voice.AgentSession | null = null;
  let consultRoom: Room | null = null;

  const getCurrentBridged = () => currentBridged;
  const setCurrentBridged = (p: SipParticipant | null) => {
    currentBridged = p;
  };
  
  const getConsultRoomName = () => consultRoomName;
  const setConsultRoomName = (name: string | null) => {
    consultRoomName = name;
  };
  
  const getTransferSession = () => transferSession;
  const setTransferSession = (session: voice.AgentSession | null) => {
    transferSession = session;
  };
  
  const getConsultRoom = () => consultRoom;
  const setConsultRoom = (room: Room | null) => {
    consultRoom = room;
  };
  let consultCall: Call | null = null;
  const getConsultCall = () => consultCall;
  const setConsultCall = (call: Call | null) => {
    consultCall = call;
  };

  // Transfer state tracking
  let transferState: { state: "none" | "dialling" | "talking" | "rejected" | "failed"; description: string } = {
    state: "none",
    description: "No transfer in progress"
  };
  const getTransferState = () => transferState;
  const setTransferState = (state: "none" | "dialling" | "talking" | "rejected" | "failed", description: string) => {
    transferState = { state, description };
    logger.debug({ state, description }, "Transfer state updated");
  };

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
      const [type, data] = entries[0] as [string, unknown];
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
        { error, message: error.message, stack: error.stack, identity, roomName: room.name, hold },
        "failed to update subscriptions"
      );
    }
  };

  const onTransfer = async ({
    args,
    participant: transferParticipant,
  }: {
    args: TransferArgs;
    participant: ParticipantInfo;
  }) => {
    try {
      const transferContext: TransferContext = {
        ctx,
        room,
        participant: transferParticipant,
        args,
        agent,
        instance,
        call,
        callerId,
        calledId,
        aplisayId,
        registrationOriginated: registrationOriginated || false,
        trunkInfo,
        registrationRegistrar,
        registrationTransport,
        registrationEndpointId,
        b2buaGatewayIp: b2buaGatewayIp ?? null,
        b2buaGatewayTransport: b2buaGatewayTransport ?? null,
        options,
        sessionRef,
        setBridgedParticipant,
        setConsultInProgress,
        getConsultInProgress,
        holdParticipant,
        getCurrentBridged,
        setCurrentBridged,
        setConsultRoomName,
        getConsultRoomName,
        setTransferSession,
        getTransferSession,
        setConsultCall,
        getConsultCall,
        setConsultRoom,
        getConsultRoom,
        setTransferState,
        getTransferState,
      };

      return await handleTransfer(transferContext);
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

  // Helper function to destroy any in-progress transfer when original caller disconnects
  const endTransferActivityIfNeeded = async (reason: string) => {
    await destroyInProgressTransfer(
      getConsultInProgress,
      getConsultRoomName,
      getTransferSession,
      getConsultRoom,
      getConsultCall,
      setConsultInProgress,
      agent,
      reason,
      setTransferState
    );
  };

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
    endTransferActivityIfNeeded,
    getTransferState,
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
  getTransferState,
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
  getTransferState: () => { state: "none" | "dialling" | "talking" | "rejected" | "failed"; description: string };
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
                  transfer_status: async () => {
                    const state = getTransferState();
                    logger.debug({ state }, "transfer_status called");
                    return {
                      state: state.state,
                      description: state.description,
                    };
                  },
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
  checkForHangup,
  sessionRef,
  modelRef,
  getConsultInProgress,
  holdParticipant,
  getActiveCall,
  endTransferActivityIfNeeded,
  getTransferState,
}: RunAgentWorkerParams & { 
  endTransferActivityIfNeeded: (reason: string) => Promise<void>;
  getTransferState: () => { state: "none" | "dialling" | "talking" | "rejected" | "failed"; description: string };
}) {
  const plugin = modelName.match(/livekit:(\w+)\//)?.[1];
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
    getTransferState,
  });

  const model = new voice.Agent({
    instructions: agent?.prompt || "You are a helpful assistant.",
    tools,
  });
  modelRef(model);
  const maxDurationString: string = agent?.options?.maxDuration || "305s";
  const maxDuration =
    1000 * parseInt(maxDurationString.match(/(\d+)s/)?.[1] || "305");

  const session = new voice.AgentSession({
    llm: new realtime.RealtimeModel({
      voice: agent?.options?.tts?.voice,
      maxDuration: maxDurationString,
      instructions: agent?.prompt || "You are a helpful assistant.",
    }),
  });
  sessionRef(session);

  // Listen on all the things for now (debug)
  Object.keys(voice.AgentSessionEventTypes).forEach((event) => {
    session.on(
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
        // End transfer activity if in progress (fire and forget)
        endTransferActivityIfNeeded("Agent initiated hangup").catch((transferError) => {
          logger.error({ transferError }, "error ending transfer activity during hangup");
        });
        getActiveCall().end("agent initiated hangup");
        roomService.deleteRoom(room.name);
      }
    }
  );

  session.on(voice.AgentSessionEventTypes.Error, (ev: voice.ErrorEvent) => {
    logger.error({ ev }, "error");
  });

  session.on(voice.AgentSessionEventTypes.Close, async (ev: voice.CloseEvent) => {
    logger.info({ ev }, "session closed");
    // End transfer activity if in progress
    try {
      await endTransferActivityIfNeeded("Session closed");
    } catch (transferError) {
      logger.error({ transferError }, "error ending transfer activity during session close");
    }
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
        // This is a bridged participant (blind transfer)
        logger.debug("bridge participant disconnected, shutting down");
        // End transfer activity if in progress (shouldn't happen for blind transfers, but just in case)
        try {
          await endTransferActivityIfNeeded("Bridged participant disconnected");
        } catch (transferError) {
          logger.error({ transferError }, "error ending transfer activity during bridged participant disconnect");
        }
        session.close();
        getActiveCall().end("bridged participant disconnected");
        await roomService.deleteRoom(room.name);
      } else if (p?.info?.identity === "transfer-target") {
        // This is a transfer target that was moved to the main room after a consultative transfer
        // The transfer is complete, so if they disconnect, we should shut down the room
        logger.debug("transfer target disconnected from main room after consultative transfer, shutting down");
        session.close();
        getActiveCall().end("transfer target disconnected");
        await roomService.deleteRoom(room.name);
      } else if (p.info?.sid === participant?.sid) {
        logger.debug("participant disconnected, shutting down");
        // End transfer activity if in progress
        try {
          await endTransferActivityIfNeeded("Original participant disconnected");
        } catch (transferError) {
          logger.error({ transferError }, "error ending transfer activity during original participant disconnect");
        }
        session.close();
        getActiveCall().end("original participant disconnected");
        await roomService.deleteRoom(room.name);
      }
    }
  );

  // Hard stop timeout on the session which is 5 seconds after the AI agent maxDuration
  // This is to ensure that the session is closed and the room is deleted even if the
  // AI agent fails to close the session (e.g OpenAI has no maxDuration parameter)
  setTimeout(() => {
    // If the bridged participant is present, we have transferred out, ignore the session timeout.
    if (getBridgedParticipant()) {
      logger.debug("bridged participant present, ignoring session timeout");
      return;
    }
    logger.debug("session timeout, generating reply");
    try {
      session.generateReply({ userInput: "The session has timed out." });
    } catch (e) {
      logger.info({ e }, "error generating timeout reply");
    }
    // 10 secs later, tear everything down
    setTimeout(async () => {
      try {
        // End transfer activity if in progress
        try {
          await endTransferActivityIfNeeded("Session timeout");
        } catch (transferError) {
          logger.error({ transferError }, "error ending transfer activity during session timeout");
        }
        getActiveCall().end("session timeout");
        session.close();
        roomService.deleteRoom(room.name);
      } catch (e) {
        logger.info({ e }, "error tearing down call on timeout");
      }
    }, 10 * 1000);
  }, maxDuration + 5 * 1000);

  logger.debug("session started, generating reply");
  session.generateReply({ userInput: initialMessage });
  call.start();
  sendMessage({ call: `${callerId} => ${calledId}` });
}
