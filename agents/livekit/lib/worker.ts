// External dependencies
import dotenv from "dotenv";
import { RoomServiceClient } from "livekit-server-sdk";
import {
  type JobContext,
  defineAgent,
  getJobContext,
  voice,
  llm
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
  endCallById,
  getAgentById,
  setCallRecordingData,
} from "./api-client.js";
import {
  handleTransfer,
  type TransferContext,
  destroyInProgressTransfer,
} from "./transfer-handler.js";
import { withTimeout } from "./utils.js";

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
import {
  startRoomRecording,
  uploadRecorderIOToGcs,
  type RoomRecordingHandle,
} from "./call-recording.js";

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
    let endTransferActivityIfNeeded:
      | ((reason: string) => Promise<void>)
      | null = null;

    try {
      const scenario = await getCallInfo(ctx, room);
      logger.info({ scenario }, "scenario");

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
        registrationOriginated,
        trunkInfo,
        registrationRegistrar,
        registrationTransport,
        registrationEndpointId,
        b2buaGatewayIp = null,
        b2buaGatewayTransport = null,
        forceBridged,
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
        forceBridged,
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
            callerId || "unknown"
          );
          if (!participant) {
            throw new Error("Outbound call failed to create participant");
          }
        } catch (err) {
          const failureReason = (err as Error).message.replace(
            /^twirp [^:]*: /,
            ""
          );
          logger.error({ err, failureReason }, "Outbound call failed");
          // Notify listeners in-room about the failure
          sendMessage({
            call_failed: failureReason,
          });
          // For failed outbound calls we still want to emit
          // a call start and end so downstream systems see a
          // complete call lifecycle with a clearing reason.
          try {
            const failureTimestamp = new Date();
            // Best effort: log an immediate start then end. The
            // timestamps will be near-identical and represent a
            // call that failed to connect.
            await call.start();
            await call.end(`Outbound call failed: ${failureReason}`);
            logger.info(
              {
                callId: call.id,
                failureReason,
                failureTimestamp,
              },
              "Logged start and immediate end for failed outbound call"
            );
          } catch (loggingError) {
            logger.error(
              { loggingError, failureReason, callId: call?.id },
              "Failed to log start/end for failed outbound call"
            );
          }
          throw err;
        }
      }

      // Record the appropriate transaction at the top level
      sendMessage({ answer: callerId });

      /**
       * Fallback loop around the core agent worker.
       *
       * Behaviour:
       *  - First attempt runs with the primary modelName from the agent.
       *  - On setup/timeout error from runAgentWorker (i.e. before call.start),
       *    we consult the current agent's options.fallback with precedence:
       *      1. fallback.agent  – fetch and substitute a different agent, then retry.
       *      2. fallback.model  – retry the same agent with a different modelName.
       *      3. fallback.number – perform a blind transfer to this number and exit.
       *
       * Once we have switched to a fallback agent, any further fallback decisions are
       * controlled by that agent's own options.fallback.
       */
      let activeAgent = agent;
      let activeModelName = modelName;
      let usedFallbackModel = false;
      let usedFallbackAgent = false;

      // Try primary and any configured model/agent fallbacks until we either succeed
      // or exhaust the configured options and fall back to a transfer/propagated error.
      fallbackLoop: while (true) {
        const fallbackConfig = activeAgent.options?.fallback;

        const activeRecordingOptions =
          instance.recording ?? activeAgent.options?.recording;

        try {
          await runAgentWorker({
            ctx,
            room,
            agent: activeAgent,
            participant,
            callerId,
            calledId,
            modelName: activeModelName,
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
            getActiveCall,
            endTransferActivityIfNeeded: endTransferActivityFn,
            getTransferState,
            recordingOptions: activeRecordingOptions,
          });
          // Successful run – break out of fallback loop
          break fallbackLoop;
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          logger.error(
            { error, message: error.message, fallbackConfig },
            "runAgentWorker failed, evaluating fallback options"
          );

          // If there is no fallback configuration on the current agent, propagate the error
          if (!fallbackConfig) {
            throw error;
          }

          // 1. Agent-level fallback: fetch and substitute a different agent
          if (
            !usedFallbackAgent &&
            fallbackConfig.agent &&
            fallbackConfig.agent !== activeAgent.id
          ) {
            try {
              logger.info(
                {
                  previousAgentId: activeAgent.id,
                  fallbackAgentId: fallbackConfig.agent,
                },
                "Retrying with fallback agent after failure"
              );
              const nextAgent = await getAgentById(fallbackConfig.agent);
              if (!nextAgent) {
                throw new Error(`Fallback agent ${fallbackConfig.agent} not found`);
              }
              if (nextAgent.userId !== activeAgent.userId && nextAgent.organisationId !== activeAgent.organisationId) {
                throw new Error(`Fallback agent ${fallbackConfig.agent} does not belong to the same user or organization as the primary agent`);
              }
              // Ensure nextAgent.options is parsed if needed
              let nextAgentOptions = nextAgent.options || {};
              // Switch active agent and model; subsequent fallback decisions will
              // be driven by the new agent's options.fallback.
              activeAgent = { ...nextAgent, options: nextAgentOptions };
              activeModelName = nextAgent.modelName;
              usedFallbackAgent = true;
              usedFallbackModel = false; // reset model fallback when switching agent
              continue fallbackLoop;
            } catch (agentError) {
              const aErr =
                agentError instanceof Error
                  ? agentError
                  : new Error(String(agentError));
              logger.error(
                {
                  error: aErr,
                  message: aErr.message,
                  stack: aErr.stack,
                  fallbackAgentId: fallbackConfig.agent,
                },
                "Failed to fetch or use fallback agent; continuing to other fallbacks"
              );
              // Fall through to model/number fallbacks
            }
          }

          // 2. Model-level fallback (restart with a different modelName)
          if (
            !usedFallbackModel &&
            fallbackConfig.model &&
            activeModelName !== fallbackConfig.model
          ) {
            logger.info(
              {
                previousModelName: activeModelName,
                fallbackModelName: fallbackConfig.model,
              },
              "Retrying agent with fallback model after failure"
            );
            usedFallbackModel = true;
            activeModelName = fallbackConfig.model;
            // Loop again with updated modelName
            continue fallbackLoop;
          }

          // 3. Number-level fallback (transfer to a phone number / endpoint)
          if (fallbackConfig.number) {
            try {
              logger.info(
                {
                  fallbackNumber: fallbackConfig.number,
                  error: error.message,
                },
                "Invoking fallback transfer after agent/model failure"
              );

              if (participant) {
                // Use runAgentWorker in transfer-only mode to set up proper handlers
                // This ensures we can detect when the transfer completes
                await runAgentWorker({
                  ctx,
                  room,
                  agent: activeAgent,
                  participant,
                  callerId,
                  calledId,
                  modelName: activeModelName, // Not used in transfer-only mode
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
                  getActiveCall,
                  endTransferActivityIfNeeded: endTransferActivityFn,
                  getTransferState,
                  transferOnly: true,
                  transferArgs: {
                    number: fallbackConfig.number,
                    operation: "blind",
                  },
                });
              } else {
                logger.warn(
                  {
                    fallbackNumber: fallbackConfig.number,
                  },
                  "No participant available for fallback transfer"
                );
                throw new Error("No participant available for fallback transfer");
              }
            } catch (transferError) {
              const tErr =
                transferError instanceof Error
                  ? transferError
                  : new Error(String(transferError));
              logger.error(
                {
                  error: tErr,
                  message: tErr.message,
                  stack: tErr.stack,
                  fallbackNumber: fallbackConfig.number,
                },
                "Fallback transfer failed"
              );
              // Re-throw to trigger outer error handling
              throw tErr;
            }

            // After attempting fallback transfer, break – call lifecycle will be
            // controlled by the transfer handler from this point on.
            break fallbackLoop;
          }

          // No applicable fallback path left; rethrow to outer handler
          throw error;
        }
      }
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
          logger.error(
            { transferError },
            "error ending transfer activity during error cleanup"
          );
        }
      }
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
  let bridgedParticipant: ParticipantInfo | null = null;
  let outboundCall = false;
  let outboundInfo: OutboundInfo | null = null;
  let registrationOriginated = false;
  let trunkInfo: TrunkInfo | null = null;
  let registrationRegistrar: string | null = null;
  let registrationTransport: string | null = null;
  let registrationEndpointId: string | null = null;
  let b2buaGatewayIp: string | null = null;
  let b2buaGatewayTransport: string | null = null;
  let forceBridged: boolean | undefined = undefined;
  /*

  Because we throw every media scenario into the same agent dispatch, working out which agent and capabilities from 
  the scenario is a bit complex:
  Outbound calls: our manual dispatch puts the number we want to call, CID and agent instanceID in the Job Metadata
  Inbound WebRTC calls: again, we put the instanceId in the Job Metadata as `identity` when we dispatch the call
  Inbound SIP calls: the livekit SIP call routing and dispatch puts SIP header information in the participant attributes
                      we use this to extract the called number, and then lookup which agent instance we should answer with.
  
  */
  try {
    // Various APIs may timeout here, so we need to set a timeout to avoid blocking the job.
    await withTimeout(
      async () => {
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
             participant = participants.find(
            (p) => p.identity !== "sip-outbound-call"
          ) as ParticipantInfo;
          bridgedParticipant = participants.find(
            (p) => p.identity === "sip-outbound-call"
          ) as ParticipantInfo | null;
          logger.debug(
            {
              participants: participants.length,
              participant,
              bridgedParticipant,
            },
            "have bridged participant?"
          );
          if (identity) {
            logger.debug({ identity }, "getting instance by identity");
            instance = await getInstanceById(identity);
            logger.debug({ instance }, "instance found?");
          } else if (room.name && participant?.attributes) {
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
                logger.info(
                  { b2buaGatewayIp, b2buaGatewayTransport },
                  "Extracted B2BUA gateway information from participant attributes"
                );
              }

              // If we have sipHostname but no registrar from endpoint lookup, use sipHostname
              // (sipHostname is the registrar hostname from the inbound call)
              if (
                phoneRegistration &&
                sipHostnameAttr &&
                !registrationRegistrar
              ) {
                registrationRegistrar = sipHostnameAttr;
                logger.info(
                  { sipHostname: sipHostnameAttr },
                  "Using sipHostname as registrar from participant attributes"
                );
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
              const phoneEndpoint = await getPhoneEndpointById(
                phoneRegistration
              );
              if (phoneEndpoint && "id" in phoneEndpoint) {
                const regInfo = phoneEndpoint as PhoneRegistrationInfo;
                logger.info(
                  { phoneEndpoint: regInfo },
                  "found phone registration endpoint"
                );
                // Store registrar and transport for transfer operations
                registrationRegistrar = regInfo.registrar || null;
                registrationTransport = regInfo.options?.transport || null;
                // Store forceBridged option from phone registration endpoint
                if (regInfo.options?.forceBridged !== undefined) {
                  forceBridged = regInfo.options.forceBridged === true;
                  logger.info(
                    { forceBridged, phoneRegistration },
                    "Extracted forceBridged from phone registration options"
                  );
                }
                // PhoneRegistration now has instanceId, so we can lookup the instance
                if (regInfo.instanceId) {
                  instance = await getInstanceById(regInfo.instanceId);
                  logger.info(
                    { instanceId: regInfo.instanceId, instance },
                    "found instance from registration instanceId"
                  );
                }
              }
            } else if (calledId) {
              logger.info(
                { callerId, calledId, aplisayId },
                "new Livekit inbound telephone call, looking up phone endpoint by number"
              );
              // Pass trunkId (aplisayId) for validation - will throw error if mismatch
              const phoneEndpoint = await getPhoneEndpointByNumber(
                calledId,
                aplisayId
              );
              if (phoneEndpoint && "number" in phoneEndpoint) {
                const numInfo = phoneEndpoint as PhoneNumberInfo;
                logger.info(
                  { phoneEndpoint: numInfo },
                  "found phone number endpoint"
                );
                // Store trunk info if available
                if (numInfo.trunk) {
                  trunkInfo = numInfo.trunk;
                  logger.info(
                    { trunkInfo },
                    "trunk info retrieved from phone endpoint"
                  );
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
      },
      5000,
      new Error("Call setup timeout (getCallInfo)"),
      () => logger.error({ ctx }, "info timeout")
    );
  } catch (e) {
    logger.error({ e }, "error getting call info");
  }
  if (!instance) {
    logger.error(
      { participant },
      `no instance found for inbound call (${calledId} => ${callerId} or ${identity})`
    );
    throw new Error("No instance found");
  }

  agent = agent || (instance as Instance)?.Agent || null;
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
    registrationOriginated,
    trunkInfo,
    registrationRegistrar,
    registrationTransport,
    registrationEndpointId,
    b2buaGatewayIp,
    b2buaGatewayTransport,
    forceBridged,
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
  registrationOriginated,
  trunkInfo,
  registrationRegistrar,
  registrationTransport,
  registrationEndpointId,
  b2buaGatewayIp,
  b2buaGatewayTransport,
  forceBridged,
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
  const setBridgedCallRecord = (call: Call | null) => {
    bridgedCallRecord = call;
  };

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
  let transferState: {
    state: "none" | "dialling" | "talking" | "rejected" | "failed";
    description: string;
  } = {
    state: "none",
    description: "No transfer in progress",
  };
  const getTransferState = () => transferState;
  const setTransferState = (
    state: "none" | "dialling" | "talking" | "rejected" | "failed",
    description: string
  ) => {
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

  const sendMessage = async (message: MessageData, createdAt?: Date) => {
    try {
      const entries = Object.entries(message);
      if (entries.length > 0) {
        const [type, data] = entries[0] as [string, unknown];
        ctx.room.localParticipant?.publishData(
          new TextEncoder().encode(JSON.stringify(message)),
          { reliable: true }
        );

        logger.debug({ message, type: typeof message }, "sending message");

        if (type === "status") {
          return;
        }

        // Use provided createdAt timestamp if available, otherwise use current time
        // This preserves the original event timestamp from ConversationItemAdded events
        const logCreatedAt = createdAt || new Date();

        const transactionLogData = {
          userId,
          organisationId,
          callId: call.id,
          type,
          data: JSON.stringify(data),
          isFinal: true,
          createdAt: logCreatedAt,
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
        forceBridged,
        options,
        sessionRef,
        setBridgedParticipant,
        setConsultInProgress,
        getConsultInProgress,
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
        setBridgedCallRecord,
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
      return { error: error.message };
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
  sendMessage: (message: MessageData, createdAt?: Date) => Promise<void>;
  metadata: CallMetadata;
  onHangup: () => Promise<void>;
  onTransfer: ({
    args,
    participant,
  }: {
    args: TransferArgs;
    participant: ParticipantInfo;
  }) => Promise<ParticipantInfo>;
  getTransferState: () => {
    state: "none" | "dialling" | "talking" | "rejected" | "failed";
    description: string;
  };
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
              return data;
            } catch (e) {
              const message = (e as Error).message;
              logger.info({ error: message }, "error executing function");
              throw new Error(`error executing function: ${message}`);
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
  getActiveCall,
  endTransferActivityIfNeeded,
  getTransferState,
  recordingOptions,
  transferOnly = false,
  transferArgs,
}: RunAgentWorkerParams & {
  endTransferActivityIfNeeded: (reason: string) => Promise<void>;
  getTransferState: () => {
    state: "none" | "dialling" | "talking" | "rejected" | "failed";
    description: string;
  };
}) {
  let recordingHandle: RoomRecordingHandle | null = null;
  let recordingServerKey: string | undefined;
  /** When true, recording uses SDK RecorderIO (pipeline tee); we upload OGG in cleanup. */
  let useRecorderIO = false;

  // If transferOnly mode, skip agent setup and go straight to transfer handling
  if (transferOnly && transferArgs && participant) {
    logger.info(
      { transferArgs, fallbackTransfer: true },
      "Running in transfer-only mode for fallback transfer"
    );

    // Set up participant disconnect handlers BEFORE transfer to ensure they're ready
    const disconnectHandler = async (p: RemoteParticipant) => {
      const bp = getBridgedParticipant();
      logger.info(
        { 
          p: { sid: p?.info?.sid, identity: p?.info?.identity },
          bridgedParticipant: bp,
          originalParticipant: { sid: participant?.sid, identity: participant?.identity },
          roomParticipants: (await roomService.listParticipants(room.name)).map(pp => ({ sid: pp.sid, identity: pp.identity }))
        },
        "participant disconnected (transfer-only mode)"
      );
      
      // Check if this is the bridged participant (transfer target)
      if (
        bp &&
        (bp.participantId === p?.info?.sid || bp.participantIdentity === p?.info?.identity)
      ) {
        logger.info("bridged participant disconnected, shutting down (transfer-only mode)");
        try {
          await endTransferActivityIfNeeded("Bridged participant disconnected");
        } catch (transferError) {
          logger.error(
            { transferError },
            "error ending transfer activity during bridged participant disconnect"
          );
        }
        await call.end("Bridged participant disconnected");
        await roomService.deleteRoom(room.name).catch((e) => {
          logger.error({ e }, "error deleting room");
        });
        await ctx.shutdown("Bridged participant disconnected");
        process.exit(0);
      } 
      // Check if this is the original participant (caller)
      else if (p.info?.sid === participant?.sid || p.info?.identity === participant?.identity) {
        logger.info("original participant disconnected, shutting down (transfer-only mode)");
        try {
          await endTransferActivityIfNeeded("Original participant disconnected");
        } catch (transferError) {
          logger.error(
            { transferError },
            "error ending transfer activity during original participant disconnect"
          );
        }
        await call.end("Original participant disconnected");
        await roomService.deleteRoom(room.name).catch((e) => {
          logger.error({ e }, "error deleting room");
        });
        await ctx.shutdown("Original participant disconnected");
        process.exit(0);
      } else {
        logger.debug(
          { 
            disconnectedParticipant: { sid: p?.info?.sid, identity: p?.info?.identity },
            bridgedParticipant: bp,
            originalParticipant: { sid: participant?.sid, identity: participant?.identity }
          },
          "Unknown participant disconnected, ignoring"
        );
      }
    };

    ctx.room.on(RoomEvent.ParticipantDisconnected, disconnectHandler);

    // Connect to the room and start the call
    await ctx.connect();
    await call.start();
    sendMessage({ call: `${callerId} => ${calledId}` });
    sendMessage({ 
      agent: `Transferring call to ${transferArgs.number} due to agent failure` 
    });

    // Perform the transfer
    try {
      await onTransfer({
        args: transferArgs,
        participant,
      });
      logger.info(
        { transferArgs },
        "Fallback transfer initiated successfully in transfer-only mode"
      );
    } catch (transferError) {
      const tErr =
        transferError instanceof Error
          ? transferError
          : new Error(String(transferError));
      logger.error(
        {
          error: tErr,
          message: tErr.message,
          stack: tErr.stack,
          transferArgs,
        },
        "Fallback transfer failed in transfer-only mode"
      );
      await call.end(`Fallback transfer failed: ${tErr.message}`);
      await roomService.deleteRoom(room.name).catch((e) => {
        logger.error({ e }, "error deleting room");
      });
      await ctx.shutdown(tErr.message);
      return;
    }

    // In transfer-only mode, we just wait for the transfer to complete
    // The ParticipantDisconnected handler above will clean up when done
    // Don't return - let the function continue to keep the process alive
    // The handler will call process.exit(0) when cleanup is done
    return;
  }

  const plugin = modelName.match(/livekit:(\w+)\//)?.[1];
  let timerId: NodeJS.Timeout | null = null;
  let operation: string | null = null;
  const realtime =
    plugin && (realtimeModels as Record<string, any>)[plugin]?.realtime;
  // Extract the underlying provider model name (e.g. "gpt-4o", "fixie-ai/ultravox-70B")
  // from a LiveKit-style modelName such as "livekit:openai/gpt-4o" or
  // "livekit:ultravox/fixie-ai/ultravox-70B".
  // If parsing fails we fall back to each plugin's internal default.
  const providerModelNameMatch = modelName.match(/^livekit:[^/]+\/(.+)$/);
  const providerModelName = providerModelNameMatch
    ? providerModelNameMatch[1]
    : undefined;

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

  let session: voice.AgentSession | null = null;
  let maxDuration: number = 305000; // Default value
  let callStarted = false;

  // DTMF buffering: accumulate digits and send as a single input after timeout
  let dtmfBuffer: string = "";
  let dtmfTimeout: NodeJS.Timeout | null = null;
  const DTMF_TIMEOUT_MS = 1500; // 1.5 seconds of silence before sending
  const DTMF_TERMINATOR = "#"; // Send immediately when this is pressed

  const cleanupAndClose = async (
    reason: string,
    logEndCall: boolean = false
  ) => {
    const exitStatus: {
      callEnded: boolean;
      roomDeleted: boolean;
      contextShutdown: boolean;
      error: string | null;
    } = {
      callEnded: false,
      roomDeleted: false,
      contextShutdown: false,
      error: null,
    };

    // The room delete and ctx.shutdown should drain all processing and cause the process to exit,
    // but there is evidence in high load environments of zombie process buildup.
    // Force a hard exit after 120 seconds to avoid this until we figure out why.
    setTimeout(() => {
      logger.info(
        { exitStatus, reason },
        "timeout whilst closing room, forcing a hard process exit after 120 seconds"
      );
      process.exit(0);
    }, 120 * 1000).unref(); // Ensure *this* timer doesn't block process exit.

    try {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      // Clean up DTMF timeout if active
      if (dtmfTimeout) {
        clearTimeout(dtmfTimeout);
        dtmfTimeout = null;
      }
      // Flush any pending DTMF buffer before closing
      if (dtmfBuffer.length > 0 && session) {
        logger.debug(
          { buffer: dtmfBuffer },
          "Flushing remaining DTMF buffer during cleanup"
        );
        try {
          session.generateReply({ userInput: dtmfBuffer });
        } catch (e) {
          logger.debug({ e }, "Failed to flush DTMF buffer during cleanup");
        }
        dtmfBuffer = "";
      }
      try {
        // dont wait for this to complete, it may block logging the call end
        //  if the LLM interface has outstanding actions let it happen in the background
        session && session.close();
      } catch (e) {
        logger.info(
          { e },
          "error closing session (may have already been called)"
        );
      }

      // Stop recording (if active) and persist recording metadata
      if (recordingHandle) {
        try {
          await recordingHandle.stop();
          await setCallRecordingData(
            getActiveCall().id,
            recordingHandle.gcsObject,
            recordingServerKey,
          );
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          logger.error(
            { error, message: error.message },
            "error stopping recording or saving recording metadata during cleanup",
          );
        } finally {
          recordingHandle = null;
        }
      } else if (useRecorderIO) {
        try {
          const sessionDir = (ctx as { sessionDirectory?: string }).sessionDirectory;
          if (sessionDir) {
            const { gcsObject } = await uploadRecorderIOToGcs(sessionDir, getActiveCall().id);
            await setCallRecordingData(getActiveCall().id, gcsObject, undefined);
            logger.info({ callId: getActiveCall().id, gcsObject }, "uploaded RecorderIO recording to GCS");
          } else {
            logger.warn({ callId: getActiveCall().id }, "RecorderIO used but no session directory; recording not persisted");
          }
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          logger.error(
            { error, message: error.message, callId: getActiveCall().id },
            "error uploading RecorderIO recording or saving recording metadata during cleanup",
          );
        }
      }

      await getActiveCall()
        .end(reason)
        .catch((e) => {
          logger.error({ e }, "error ending call");
        });
      exitStatus.callEnded = true;

      await roomService.deleteRoom(room.name).catch((e) => {
        logger.error({ e }, "error deleting room");
      });
      exitStatus.roomDeleted = true;

      await ctx.shutdown(reason);
      exitStatus.contextShutdown = true;
      logger.info({ exitStatus, reason }, "cleanup and close completed");
      process.exit(0);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.info(
        { message: error.message, error },
        "error cleaning up and closing"
      );
      exitStatus.error =
        error.message || "unknown error caught during cleanup and close";
    }
  };

  try {
    // Wrap setup operations with timeout
    await withTimeout(
      async () => {
        operation = "createTools";
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

        operation = "createModel";
        logger.debug({ tools }, "Creating model");
        const model = new voice.Agent({
          instructions: agent?.prompt || "You are a helpful assistant.",
          tools,
        });
        modelRef(model);
        const maxDurationString: string = agent?.options?.maxDuration || "305s";
        maxDuration =
          1000 * parseInt(maxDurationString.match(/(\d+)s/)?.[1] || "305");

        operation = "createSession";
        const llmOptions: Record<string, unknown> = {
          voice: agent?.options?.tts?.voice,
          maxDuration: maxDurationString,
          instructions: agent?.prompt || "You are a helpful assistant.",
        };
        if (providerModelName) {
          llmOptions.model = providerModelName;
          logger.info(
            { modelName, providerModelName },
            "Using provider model for realtime LLM"
          );
        }
        // Pass vendor-specific options if present
        if (agent?.options?.vendorSpecific) {
          llmOptions.vendorSpecific = agent.options.vendorSpecific;
        }
        logger.debug({ llmOptions }, "Creating session");
        session = new voice.AgentSession({
          llm: new realtime.RealtimeModel(llmOptions),
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
          ({ item: { type, role, content }, createdAt }: voice.ConversationItemAddedEvent) => {
            if (type === "message" && getConsultInProgress() === false) {
              const text = content.join("");
              if (role !== "user" || text !== initialMessage) {
                sendMessage(
                  {
                    [role === "user" ? "user" : "agent"]: text,
                  },
                  createdAt ? new Date(createdAt) : undefined
                );
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

        session.on(
          voice.AgentSessionEventTypes.AgentStateChanged,
          (ev: voice.AgentStateChangedEvent) => {
            sendMessage({ status: ev.newState });
            if (ev.newState === "listening" && checkForHangup() && room.name) {
              logger.debug({ room }, "room close inititiated");
              // End transfer activity if in progress (fire and forget)
              endTransferActivityIfNeeded("Agent initiated hangup").catch(
                (transferError) => {
                  logger.error(
                    { transferError },
                    "error ending transfer activity during hangup"
                  );
                }
              );
              getActiveCall().end("agent initiated hangup");
              roomService.deleteRoom(room.name);
            }
          }
        );

        session.on(voice.AgentSessionEventTypes.Error, (ev: voice.ErrorEvent) => {
          logger.error({ ev }, "error");
        });

        // Watch for any non-recoverable model/STT/TTS errors that occur while
        // the session is still starting. If we see one before callStarted is
        // set, we treat it as a setup failure so the outer fallback loop can
        // switch models/agents or perform a transfer.
        let startupErrorUnsubscribe: (() => void) | null = null;
        const startupErrorPromise = new Promise<never>((_, reject) => {
          const sessionForStartup = session;
          if (!sessionForStartup) {
            // Should not happen, but fail fast if it does.
            reject(
              new Error(
                "Agent session not available during startup error monitoring"
              )
            );
            return;
          }

          const handler = (ev: voice.ErrorEvent) => {
            // If the call has already been marked as started, this is a
            // runtime error and should not influence startup / fallback logic.
            if (callStarted) {
              return;
            }

            const errAny: any = ev.error;
            const errType = errAny?.type;
            const isRealtimeModelError = errType === "realtime_model_error";
            const isRecoverable = !!errAny?.recoverable;

            // Ignore explicitly recoverable realtime model errors during startup.
            if (isRealtimeModelError && isRecoverable) {
              return;
            }

            // For any other error type (or non‑recoverable realtime model
            // error), treat this as a fatal startup failure.
            if (startupErrorUnsubscribe) {
              startupErrorUnsubscribe();
            }

            const underlyingError: Error =
              isRealtimeModelError && errAny?.error instanceof Error
                ? errAny.error
                : errAny instanceof Error
                ? errAny
                : new Error(
                    String(
                      errAny?.message ||
                        "Agent session startup error (realtime model / STT / TTS)"
                    )
                  );

            reject(underlyingError);
          };

          sessionForStartup.on(
            voice.AgentSessionEventTypes.Error,
            handler as any
          );
          startupErrorUnsubscribe = () => {
            const unsubscribeSession = sessionForStartup;
            if (unsubscribeSession) {
              unsubscribeSession.off(
                voice.AgentSessionEventTypes.Error,
                handler as any
              );
            }
            startupErrorUnsubscribe = null;
          };
        });

        session.on(
          voice.AgentSessionEventTypes.Close,
          async (ev: voice.CloseEvent) => {
            logger.info({ ev }, "session closed");
            // End transfer activity if in progress
            try {
              await endTransferActivityIfNeeded("Session closed");
            } catch (transferError) {
              logger.error(
                { transferError },
                "error ending transfer activity during session close"
              );
            }
            roomService.deleteRoom(room.name);
            getActiveCall().end("session closed");
          }
        );

        // Recording: use RecorderIO (pipeline tee) when recording is enabled; otherwise no recording.
        // RecorderIO writes OGG to the job session directory; we upload it to GCS in cleanup.
        if (!transferOnly && recordingOptions && recordingOptions.enabled) {
          useRecorderIO = true;
          logger.info(
            { callId: call.id },
            "recording enabled via RecorderIO (pipeline tee); will upload OGG in cleanup",
          );
        }

        operation = "sessionStart";
        await Promise.race([
          session.start({
            room: ctx.room,
            agent: model,
            record: recordingOptions?.enabled ?? false,
          }),
          startupErrorPromise,
        ]);
        callStarted = true;

        // Once startup has succeeded, we no longer need the startup-specific
        // error watcher; subsequent errors are treated as runtime failures.
        (startupErrorUnsubscribe as (() => void) | null)?.();

        operation = "connect";
        await ctx.connect();
      },
      15000,
      new Error("Call setup timeout (runAgentWorker)"),
      () => logger.error({ ctx, operation }, `info timeout during ${operation || "unknown"}`)
    );

    logger.debug({ room }, "connected got room");

    const flushDtmfBuffer = () => {
      if (dtmfBuffer.length > 0 && session) {
        const digitsToSend = dtmfBuffer;
        dtmfBuffer = ""; // Clear buffer before sending
        logger.debug(
          { digits: digitsToSend },
          "Flushing accumulated DTMF digits to LLM"
        );
        try {
          session.generateReply({ userInput: digitsToSend });
        } catch (e) {
          logger.error(
            { error: e, digits: digitsToSend },
            "Failed to inject DTMF digits via generate_reply"
          );
        }
      }
      if (dtmfTimeout) {
        clearTimeout(dtmfTimeout);
        dtmfTimeout = null;
      }
    };

    ctx.room.on(RoomEvent.DtmfReceived, async (code, digit, participant) => {
      logger.debug(
        {
          identity: participant.identity,
          code,
          digit,
          currentBuffer: dtmfBuffer,
        },
        "DTMF received from participant"
      );

      if (!session) {
        logger.warn("Session not available, cannot buffer DTMF digit");
        return;
      }

      // If terminator is pressed, send immediately (don't add terminator to buffer)
      if (digit === DTMF_TERMINATOR) {
        logger.debug(
          { buffer: dtmfBuffer },
          "DTMF terminator pressed, sending immediately"
        );
        flushDtmfBuffer();
        return;
      }

      // Add digit to buffer
      dtmfBuffer += digit;

      // Clear existing timeout and set a new one
      if (dtmfTimeout) {
        clearTimeout(dtmfTimeout);
      }

      // Set timeout to flush buffer after period of inactivity
      dtmfTimeout = setTimeout(() => {
        logger.debug(
          { buffer: dtmfBuffer },
          "DTMF timeout reached, flushing buffer"
        );
        flushDtmfBuffer();
      }, DTMF_TIMEOUT_MS);
    });
    logger.debug("DTMF listener registered");

    ctx.room.on(
      RoomEvent.ParticipantDisconnected,
      async (p: RemoteParticipant) => {
        const bp = getBridgedParticipant();
        logger.debug(
          { p, bridgedParticipant: bp, participant },
          "participant disconnected"
        );
        if (
          bp?.participantId === p?.info?.sid ||
          bp?.participantIdentity === p?.info?.identity
        ) {
          if (getConsultInProgress()) {
            logger.debug(
              "consult callee disconnected, treating as consult_reject"
            );
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
            // End transfer activity if in progress
            try {
              await endTransferActivityIfNeeded(
                "Bridged participant disconnected"
              );
            } catch (transferError) {
              logger.error(
                { transferError },
                "error ending transfer activity during bridged participant disconnect"
              );
            }
            await cleanupAndClose("bridged participant disconnected");
            setBridgedParticipant(null as unknown as SipParticipant);
          }
        } else if (p.info?.sid === participant?.sid) {
          logger.debug("participant disconnected, shutting down");
          // End transfer activity if in progress
          try {
            await endTransferActivityIfNeeded(
              "Original participant disconnected"
            );
          } catch (transferError) {
            logger.error(
              { transferError },
              "error ending transfer activity during original participant disconnect"
            );
          }
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
      setTimeout(async () => {
        try {
          // End transfer activity if in progress
          try {
            await endTransferActivityIfNeeded("Session timeout");
          } catch (transferError) {
            logger.error(
              { transferError },
              "error ending transfer activity during session timeout"
            );
          }
          cleanupAndClose("session timeout");
        } catch (e) {
          logger.info({ e }, "error tearing down call on timeout");
        }
      }, 10 * 1000);
    }, maxDuration + 5 * 1000);

    logger.debug("session started, generating reply");
    await call.start();

    sendMessage({ call: `${callerId} => ${calledId}` });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error(
      { error, message: error.message, stack: error.stack },
      "error running agent worker"
    );

    // If the call has not yet started, treat this as a setup failure and let the
    // caller decide whether to invoke fallback behaviour. We deliberately do NOT
    // clean up the call/room here so that the outer loop can retry with a different
    // model/agent on the same LiveKit room.
    if (!callStarted) {
      throw error;
    }

    await cleanupAndClose("UNCAUGHT ERROR: running agent worker");
  }
}
