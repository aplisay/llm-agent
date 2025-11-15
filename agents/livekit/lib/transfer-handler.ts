import { RoomServiceClient, AccessToken, VideoGrant } from "livekit-server-sdk";
import { Room } from "@livekit/rtc-node";
import { voice, llm } from "@livekit/agents";
import logger from "../agent-lib/logger.js";
import { bridgeParticipant, transferParticipant, dialTransferTargetToConsultation } from "./telephony.js";
import {
  getPhoneEndpointByNumber,
  getPhoneEndpointById,
  createCall,
  type PhoneNumberInfo,
  type PhoneRegistrationInfo,
  type TrunkInfo,
} from "./api-client.js";
import type { ParticipantInfo, SipParticipant, TransferArgs } from "./types.js";
import type { Agent, Call, Instance } from "./api-client.js";

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

const roomService = new RoomServiceClient(
  LIVEKIT_URL!,
  LIVEKIT_API_KEY!,
  LIVEKIT_API_SECRET!
);

export interface TransferContext {
  ctx: any; // JobContext
  room: Room;
  participant: ParticipantInfo;
  args: TransferArgs;
  agent: Agent;
  instance: Instance;
  call: Call;
  callerId: string;
  calledId: string;
  aplisayId: string;
  registrationOriginated: boolean;
  trunkInfo: TrunkInfo | null | undefined;
  registrationRegistrar: string | null | undefined;
  registrationTransport: string | null | undefined;
  registrationEndpointId: string | null | undefined; // Registration endpoint ID from sipHXAplisayPhoneregistration
  b2buaGatewayIp: string | null | undefined; // B2BUA gateway IP from sipHXLkRealIp
  b2buaGatewayTransport: string | null | undefined; // B2BUA gateway transport from sipHXLkTransport
  options: any;
  sessionRef: (session: voice.AgentSession | null) => voice.AgentSession | null;
  setBridgedParticipant: (p: SipParticipant | null) => void;
  setConsultInProgress: (value: boolean) => void;
  getConsultInProgress: () => boolean;
  holdParticipant: (identity: string, hold: boolean) => Promise<void>;
  getCurrentBridged: () => SipParticipant | null;
  setCurrentBridged: (p: SipParticipant | null) => void;
  // Consultation room state for warm transfers
  setConsultRoomName: (roomName: string | null) => void;
  getConsultRoomName: () => string | null;
  setTransferSession: (session: voice.AgentSession | null) => void;
  getTransferSession: () => voice.AgentSession | null;
  setConsultRoom: (room: Room | null) => void;
  getConsultRoom: () => Room | null;
  // Promise resolvers for consultative transfer decision
  resolveConsultativeDecision?: (accepted: boolean, transcript?: string) => void;
  rejectConsultativeDecision?: (error: Error) => void;
}

export interface TransferResult {
  status: "OK" | "FAILED";
  reason: string;
  transcript?: string; // For consultative transfers where target answered but rejected
  error?: Error;
}

/**
 * Determines if a participant is a SIP participant
 */
function isSipParticipant(participant: ParticipantInfo): boolean {
  return !!(
    participant.attributes?.sipTrunkPhoneNumber ||
    participant.attributes?.sipPhoneNumber ||
    participant.attributes?.sipHXAplisayTrunk
  );
}

/**
 * Determines if a participant can perform SIP REFER
 * canRefer defaults to:
 * - true for registration endpoint SIP calls
 * - false for trunk-based SIP calls (unless explicitly set to true in trunk flags)
 * - false for WebRTC participants
 * - false if trunk doesn't exist
 * 
 * @param trunkInfo - Trunk information from phone endpoint lookup (may be null)
 */
function canParticipantRefer(
  participant: ParticipantInfo,
  registrationOriginated: boolean,
  trunkInfo: TrunkInfo | null | undefined
): boolean {
  // WebRTC participants cannot REFER
  if (!isSipParticipant(participant)) {
    return false;
  }

  // Registration-originated calls default to canRefer=true
  if (registrationOriginated) {
    return true;
  }

  // For trunk-based calls, check trunk flags
  if (trunkInfo) {
    const canRefer = trunkInfo.flags?.canRefer === true;
    logger.debug({ trunkId: trunkInfo.id, canRefer, flags: trunkInfo.flags }, 'Checked canRefer from trunk flags');
    return canRefer;
  }

  // No trunk info, default to false
  logger.debug({}, 'No trunk info available, assuming canRefer=false');
  return false;
}

/**
 * Validates transfer arguments and resolves effective caller ID
 */
async function validateTransferArgs(
  args: TransferArgs,
  agent: Agent,
  calledId: string,
  aplisayId: string
): Promise<{ effectiveCallerId: string; effectiveAplisayId: string }> {
  if (!args.number.match(/^(\+44|44|0)[1237]\d{6,15}$/)) {
    throw new Error(
      "Invalid number: only UK geographic and mobile numbers are supported currently as transfer targets"
    );
  }

  let effectiveCallerId = args.callerId || calledId;
  let effectiveAplisayId = aplisayId;

  // Validate overridden callerId if provided
  if (args.callerId) {
    const pn: PhoneNumberInfo | null = await getPhoneEndpointByNumber(
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
      throw new Error("Invalid callerId: outbound not enabled on this number");
    }
    // If inbound has aplisayId, require match
    if (aplisayId) {
      if (pn.aplisayId && pn.aplisayId !== aplisayId) {
        throw new Error("Invalid callerId: aplisayId mismatch");
      }
    } else {
      // WebRTC: adopt aplisayId from outbound number if available
      if (pn.aplisayId) {
        effectiveAplisayId = pn.aplisayId;
      }
    }
    effectiveCallerId = pn.number;
  }

  return { effectiveCallerId, effectiveAplisayId };
}

/**
 * Creates a bridged call record and finalises the original call
 */
async function finaliseBridgedCall(
  call: Call,
  instance: Instance,
  agent: Agent,
  room: Room,
  callerId: string,
  calledId: string,
  options: any,
  session: voice.AgentSession | null
): Promise<Call | null> {
  // Close down the model for the agent leg
  if (session?.llm) {
    (session.llm as llm.RealtimeModel)?.close();
  }

  try {
    const originalCallId = call.id;
    const bridgedCallRecord = await createCall({
      parentId: originalCallId,
      userId: agent.userId,
      organisationId: agent.organisationId,
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
      await bridgedCallRecord.start();
    }

    return bridgedCallRecord;
  } catch (e) {
    logger.error({ e }, "failed to create bridged call record");
    return null;
  }
}

/**
 * Case 1: Blind transfer by bridging
 * Used for WebRTC or SIP participants without canRefer capability
 */
async function handleBlindBridgeTransfer(
  context: TransferContext,
  effectiveCallerId: string,
  effectiveAplisayId: string,
  finaliseBridgedCallFn: () => Promise<Call | null>
): Promise<TransferResult> {
  const { room, args, setBridgedParticipant, setConsultInProgress } = context;

  logger.info(
    { roomName: room.name, number: args.number },
    "executing blind bridge transfer"
  );

  try {
    // Mark transfer as in progress
    setConsultInProgress(true);

    const p = await bridgeParticipant(
      room.name!,
      args.number,
      effectiveAplisayId,
      effectiveCallerId
    );

    logger.info({ p }, "new participant created (blind bridge)");
    setBridgedParticipant(p);
    await finaliseBridgedCallFn();

    return {
      status: "OK",
      reason: "Transfer completed successfully",
    };
  } finally {
    // Always clear the in-progress flag, even if transfer fails
    setConsultInProgress(false);
  }
}

/**
 * Case 2: Blind transfer using SIP REFER
 * Used for SIP participants with canRefer capability
 */
async function handleBlindReferTransfer(
  context: TransferContext,
  finaliseBridgedCallFn: () => Promise<Call | null>
): Promise<TransferResult> {
  const { room, participant, args, aplisayId, registrationOriginated, registrationRegistrar, registrationTransport, setConsultInProgress } = context;

  logger.info(
    { roomName: room.name, participant: participant?.sid, number: args.number },
    "executing blind SIP REFER transfer"
  );

  try {
    // Mark transfer as in progress
    setConsultInProgress(true);

    // Determine registrar and transport for the transfer
    let registrar: string | null = null;
    let transport: string | null = null;
    
    // If the original call was from a registration endpoint, use its registrar/transport
    if (registrationOriginated && registrationRegistrar) {
      registrar = registrationRegistrar;
      transport = registrationTransport || null;
      logger.info({ registrar, transport }, 
        "Using registrar/transport from registration-originated call");
    }
    
    const tpResult = await transferParticipant(
      room.name!,
      participant.identity!,
      args.number,
      aplisayId!,
      registrar,
      transport
    );

    logger.info({ tpResult }, "transfer participant executed via SIP REFER");
    await finaliseBridgedCallFn();

    return {
      status: "OK",
      reason: "Transfer completed successfully",
    };
  } finally {
    // Always clear the in-progress flag, even if transfer fails
    setConsultInProgress(false);
  }
}

/**
 * Helper function to get transcript from TransferAgent session
 */
function getTransferAgentTranscript(transferSession: voice.AgentSession): string {
  try {
    const ctx = transferSession.chatCtx;
    const ctxCopy = ctx.copy({
      excludeEmptyMessage: true,
      excludeInstructions: true,
      excludeFunctionCall: false, // Include function calls to see accept/reject
    });

    let transcript = "";
    for (const msg of ctxCopy.items) {
      if (msg.type === "message") {
        const role = msg.role;
        const textContent = msg.textContent || "";
        if (role === "user") {
          transcript += `Transfer Target: ${textContent}\n`;
        } else if (role === "assistant") {
          transcript += `Transfer Agent: ${textContent}\n`;
        }
      }
    }
    return transcript.trim();
  } catch (error) {
    logger.error({ error }, "Error getting transfer agent transcript");
    return "";
  }
}

/**
 * Case 3: Consultative warm transfer (LiveKit pattern)
 * Uses separate consultation room with TransferAgent
 * Follows: https://docs.livekit.io/sip/transfer-warm/
 * 
 * This function starts the consultation and waits for TransferAgent decision.
 * It's used internally by handleConsultativeTransfer.
 */
async function handleWarmTransfer(
  context: TransferContext,
  effectiveCallerId: string,
  effectiveAplisayId: string
): Promise<TransferResult> {
  const {
    ctx,
    room,
    participant,
    args,
    agent,
    sessionRef,
    setConsultInProgress,
    holdParticipant,
    setConsultRoomName,
    setTransferSession,
    setConsultRoom,
  } = context;

  const session = sessionRef(null);
  if (!session) {
    throw new Error("Agent session is required for warm transfer");
  }

  logger.info(
    { roomName: room.name, number: args.number },
    "executing warm transfer (LiveKit pattern with consultation room)"
  );

  try {
    // Step 1: Place caller on hold (disable audio input and output)
    await holdParticipant(participant.sid!, true);

    // Step 2: Create consultation room
    const consultRoomName = `consult-${room.name}-${Date.now()}`;
    const transferAgentIdentity = "transfer-agent";
    const transferTargetIdentity = "transfer-target";

    // Step 3: Generate token for TransferAgent
    const accessToken = new AccessToken(
      LIVEKIT_API_KEY!,
      LIVEKIT_API_SECRET!,
      { identity: transferAgentIdentity }
    );

    const videoGrant: VideoGrant = {
      room: consultRoomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    };
    accessToken.addGrant(videoGrant);
    const token = await accessToken.toJwt();

    // Step 4: Create and connect consultation room
    const consultRoom = new Room();
    await consultRoom.connect(LIVEKIT_URL!, token);
    setConsultRoomName(consultRoomName);
    setConsultRoom(consultRoom);

    logger.info({ consultRoomName }, "consultation room created and connected");

    // Step 5: Create TransferAgent with conversation history
    const prevCtx = session.chatCtx;
    const ctxCopy = prevCtx.copy({
      excludeEmptyMessage: true,
      excludeInstructions: true,
      excludeFunctionCall: true,
    });

    let prevConvo = "";
    try {
      for (const msg of ctxCopy.items) {
        if (msg.type === "message") {
          const role = msg.role;
          const textContent = msg.textContent || "";
          if (role === "user") {
            prevConvo += `Customer: ${textContent}\n`;
          } else if (role === "assistant") {
            prevConvo += `Assistant: ${textContent}\n`;
          }
        }
      }
    } catch (error) {
      logger.error({ error }, "Error copying chat context");
    }

    // Create TransferAgent with conversation history and tools to accept/reject transfer
    const transferAgent = new voice.Agent({
      instructions: `You are a transfer assistant helping with a call transfer. Here is the conversation history with the caller: ${prevConvo}

You are now speaking with the transfer target who was called to take over this call. Your role is to:
1. Summarize the call history for the transfer target
2. Ask if they want to accept the transfer and speak with the caller
3. If they accept, call the accept_transfer function
4. If they decline, call the reject_transfer function

Be helpful and concise.`,
      tools: {
        accept_transfer: llm.tool({
          description: "Accept the transfer and connect the transfer target to the caller. Use this when the transfer target agrees to take the call.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
          execute: async () => {
            logger.info({}, "TransferAgent called accept_transfer");
            if (context.resolveConsultativeDecision) {
              context.resolveConsultativeDecision(true);
            }
            return JSON.stringify({ 
              success: true, 
              message: "Transfer accepted. Connecting transfer target to caller..."
            });
          },
        }),
        reject_transfer: llm.tool({
          description: "Reject the transfer and return the caller to the original agent. Use this when the transfer target declines to take the call.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
          execute: async () => {
            logger.info({}, "TransferAgent called reject_transfer");
            // Get transcript before resolving
            const transferSession = context.getTransferSession();
            const transcript = transferSession ? getTransferAgentTranscript(transferSession) : "";
            if (context.resolveConsultativeDecision) {
              context.resolveConsultativeDecision(false, transcript);
            }
            return JSON.stringify({ 
              success: true, 
              message: "Transfer rejected. Returning caller to original agent..."
            });
          },
        }),
      },
    });

    // Step 6: Create TransferAgent session and connect to consultation room
    const transferSession = new voice.AgentSession({
      llm: session.llm, // Reuse the same LLM instance
    });
    setTransferSession(transferSession);

    await transferSession.start({
      room: consultRoom,
      agent: transferAgent,
    });

    logger.info({}, "transfer agent started in consultation room");

    // Step 7: Dial transfer target into consultation room
    const transferTargetParticipant = await dialTransferTargetToConsultation(
      consultRoomName,
      args.number,
      effectiveCallerId,
      effectiveAplisayId,
      transferTargetIdentity,
      context.registrationOriginated,
      context.b2buaGatewayIp,
      context.b2buaGatewayTransport,
      context.registrationEndpointId
    );

    setConsultInProgress(true);

    return {
      status: "OK",
      reason: "Consultation started successfully",
    };
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({ e }, "failed to initiate warm transfer");
    await holdParticipant(participant.sid!, false);
    // Clean up consultation room if it was created
    const consultRoomName = context.getConsultRoomName();
    if (consultRoomName) {
      try {
        await roomService.deleteRoom(consultRoomName);
      } catch (cleanupError) {
        logger.error({ cleanupError }, "failed to cleanup consultation room");
      }
    }
    return {
      status: "FAILED",
      reason: `Failed to initiate warm transfer: ${error.message}`,
      error: error,
    };
  }
}

/**
 * Finalizes a warm transfer (moves transfer target to caller room, then connects them)
 * Follows LiveKit pattern: Move transfer target from consultation room to caller room
 */
export async function finaliseWarmTransfer(
  context: TransferContext,
  finaliseBridgedCallFn: () => Promise<Call | null>
): Promise<TransferResult> {
  const {
    room,
    participant,
    getConsultInProgress,
    getConsultRoomName,
    getTransferSession,
    getConsultRoom,
    setConsultInProgress,
    holdParticipant,
  } = context;

  if (!getConsultInProgress()) {
    throw new Error("No consult transfer in progress to finalise");
  }

  const consultRoomName = getConsultRoomName();
  const transferSession = getTransferSession();
  const consultRoom = getConsultRoom();

  if (!consultRoomName) {
    throw new Error("Consultation room not found");
  }

  logger.info({ consultRoomName, callerRoom: room.name }, "finalising warm transfer");

  try {
    // Step 1: Move transfer target from consultation room to caller room
    const transferTargetIdentity = "transfer-target";
    await roomService.moveParticipant(
      consultRoomName,
      transferTargetIdentity,
      room.name!
    );

    logger.info({}, "transfer target moved to caller room");

    // Step 2: Unhold the caller so they can hear the introduction
    await holdParticipant(participant.sid!, false);

    // Step 3: Close TransferAgent session and disconnect from consultation room
    if (transferSession) {
      await transferSession.close();
    }
    if (consultRoom) {
      await consultRoom.disconnect();
    }

    // Step 4: Delete consultation room
    await roomService.deleteRoom(consultRoomName);

    logger.info({}, "consultation room cleaned up");

    // Step 5: Finalize the call record
    await finaliseBridgedCallFn();

    // Step 6: Clear the in-progress flag
    setConsultInProgress(false);

    return {
      status: "OK",
      reason: "Consultative transfer completed successfully",
    };
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({ e }, "failed to finalise warm transfer");
    // Cleanup on error
    try {
      if (transferSession) {
        await transferSession.close();
      }
      if (consultRoom) {
        await consultRoom.disconnect();
      }
      if (consultRoomName) {
        await roomService.deleteRoom(consultRoomName);
      }
    } catch (cleanupError) {
      logger.error({ cleanupError }, "failed to cleanup during error");
    }
    // Always clear the flag on error
    setConsultInProgress(false);
    throw error;
  }
}

/**
 * Rejects a warm transfer (hangs up transfer target, cleans up consultation room, returns to caller)
 */
export async function rejectWarmTransfer(
  context: TransferContext
): Promise<TransferResult> {
  const {
    room,
    participant,
    getConsultInProgress,
    getConsultRoomName,
    getTransferSession,
    getConsultRoom,
    setConsultInProgress,
    holdParticipant,
  } = context;

  if (!getConsultInProgress()) {
    throw new Error("No consult transfer in progress to reject");
  }

  const consultRoomName = getConsultRoomName();
  const transferSession = getTransferSession();
  const consultRoom = getConsultRoom();

  logger.debug(
    { roomName: room.name, consultRoomName },
    "rejecting consultative transfer"
  );

  try {
    // Step 1: Remove transfer target from consultation room (hangs up call)
    if (consultRoomName) {
      try {
        await roomService.removeParticipant(
          consultRoomName,
          "transfer-target"
        );
        logger.debug({}, "removed transfer target from consultation room");
      } catch (e) {
        logger.error(
          { e, consultRoomName },
          "failed to remove transfer target from consultation room"
        );
      }
    }

    // Step 2: Close TransferAgent session and disconnect from consultation room
    if (transferSession) {
      try {
        await transferSession.close();
      } catch (e) {
        logger.error({ e }, "failed to close transfer session");
      }
    }
    if (consultRoom) {
      try {
        await consultRoom.disconnect();
      } catch (e) {
        logger.error({ e }, "failed to disconnect from consultation room");
      }
    }

    // Step 3: Delete consultation room
    if (consultRoomName) {
      try {
        await roomService.deleteRoom(consultRoomName);
        logger.debug({ consultRoomName }, "deleted consultation room");
      } catch (e) {
        logger.error({ e, consultRoomName }, "failed to delete consultation room");
      }
    }

    // Step 4: Unhold the caller
    await holdParticipant(participant.sid!, false);
  } catch (e) {
    logger.error({ e }, "error during consult rejection cleanup");
  }

  setConsultInProgress(false);

  return {
    status: "OK",
    reason: "Consultative transfer rejected, caller returned",
  };
}

/**
 * Case 4: Consultative warm transfer with SIP REFER (LiveKit pattern)
 * Uses separate consultation room with TransferAgent, then SIP REFER for transfer
 * Follows: https://docs.livekit.io/sip/transfer-warm/ but uses REFER instead of bridging
 */
async function handleWarmTransferWithRefer(
  context: TransferContext,
  effectiveCallerId: string,
  effectiveAplisayId: string
): Promise<TransferResult> {
  const {
    room,
    participant,
    args,
    agent,
    sessionRef,
    setConsultInProgress,
    holdParticipant,
    setConsultRoomName,
    setTransferSession,
    setConsultRoom,
  } = context;

  const session = sessionRef(null);
  if (!session) {
    throw new Error("Agent session is required for warm transfer with REFER");
  }

  logger.info(
    { roomName: room.name, number: args.number },
    "executing warm transfer with SIP REFER (LiveKit pattern)"
  );

  try {
    // Step 1: Place caller on hold (disable audio input and output)
    await holdParticipant(participant.sid!, true);

    // Step 2: Create consultation room
    const consultRoomName = `consult-${room.name}-${Date.now()}`;
    const transferAgentIdentity = "transfer-agent";
    const transferTargetIdentity = "transfer-target";

    // Step 3: Generate token for TransferAgent
    const accessToken = new AccessToken(
      LIVEKIT_API_KEY!,
      LIVEKIT_API_SECRET!,
      { identity: transferAgentIdentity }
    );

    const videoGrant: VideoGrant = {
      room: consultRoomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    };
    accessToken.addGrant(videoGrant);
    const token = await accessToken.toJwt();

    // Step 4: Create and connect consultation room
    const consultRoom = new Room();
    await consultRoom.connect(LIVEKIT_URL!, token);
    setConsultRoomName(consultRoomName);
    setConsultRoom(consultRoom);

    logger.info({ consultRoomName }, "consultation room created and connected");

    // Step 5: Create TransferAgent with conversation history
    const prevCtx = session.chatCtx;
    const ctxCopy = prevCtx.copy({
      excludeEmptyMessage: true,
      excludeInstructions: true,
      excludeFunctionCall: true,
    });

    let prevConvo = "";
    try {
      for (const msg of ctxCopy.items) {
        if (msg.type === "message") {
          const role = msg.role;
          const textContent = msg.textContent || "";
          if (role === "user") {
            prevConvo += `Customer: ${textContent}\n`;
          } else if (role === "assistant") {
            prevConvo += `Assistant: ${textContent}\n`;
          }
        }
      }
    } catch (error) {
      logger.error({ error }, "Error copying chat context");
    }

    // Create TransferAgent with conversation history and tools to accept/reject transfer
    const transferAgent = new voice.Agent({
      instructions: `You are a transfer assistant helping with a call transfer. Here is the conversation history with the caller: ${prevConvo}

You are now speaking with the transfer target who was called to take over this call. Your role is to:
1. Summarize the call history for the transfer target
2. Ask if they want to accept the transfer and speak with the caller
3. If they accept, call the accept_transfer function
4. If they decline, call the reject_transfer function

Be helpful and concise.`,
      tools: {
        accept_transfer: llm.tool({
          description: "Accept the transfer and connect the transfer target to the caller. Use this when the transfer target agrees to take the call.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
          execute: async () => {
            logger.info({}, "TransferAgent called accept_transfer");
            if (context.resolveConsultativeDecision) {
              context.resolveConsultativeDecision(true);
            }
            return JSON.stringify({ 
              success: true, 
              message: "Transfer accepted. Connecting transfer target to caller..."
            });
          },
        }),
        reject_transfer: llm.tool({
          description: "Reject the transfer and return the caller to the original agent. Use this when the transfer target declines to take the call.",
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
          execute: async () => {
            logger.info({}, "TransferAgent called reject_transfer");
            // Get transcript before resolving
            const transferSession = context.getTransferSession();
            const transcript = transferSession ? getTransferAgentTranscript(transferSession) : "";
            if (context.resolveConsultativeDecision) {
              context.resolveConsultativeDecision(false, transcript);
            }
            return JSON.stringify({ 
              success: true, 
              message: "Transfer rejected. Returning caller to original agent..."
            });
          },
        }),
      },
    });

    // Step 6: Create TransferAgent session and connect to consultation room
    const transferSession = new voice.AgentSession({
      llm: session.llm, // Reuse the same LLM instance
    });
    setTransferSession(transferSession);

    await transferSession.start({
      room: consultRoom,
      agent: transferAgent,
    });

    logger.info({}, "transfer agent started in consultation room");

    // Step 7: Dial transfer target into consultation room
    const transferTargetParticipant = await dialTransferTargetToConsultation(
      consultRoomName,
      args.number,
      effectiveCallerId,
      effectiveAplisayId,
      transferTargetIdentity,
      context.registrationOriginated,
      context.b2buaGatewayIp,
      context.b2buaGatewayTransport,
      context.registrationEndpointId
    );

    setConsultInProgress(true);

    return {
      status: "OK",
      reason: "Consultation started successfully with SIP REFER",
    };
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({ error }, "failed to initiate warm transfer with REFER");
    await holdParticipant(participant.sid!, false);
    // Clean up consultation room if it was created
    const consultRoomName = context.getConsultRoomName();
    if (consultRoomName) {
      try {
        await roomService.deleteRoom(consultRoomName);
      } catch (cleanupError) {
        logger.error({ cleanupError }, "failed to cleanup consultation room");
      }
    }
    return {
      status: "FAILED",
      reason: `Failed to initiate warm transfer with REFER: ${error.message}`,
      error: error,
    };
  }
}

/**
 * Finalizes a warm transfer (LiveKit pattern for case 4)
 * Moves transfer target to caller room, unholds caller, then cleans up consultation
 */
export async function finaliseWarmTransferWithRefer(
  context: TransferContext,
  finaliseBridgedCallFn: () => Promise<Call | null>
): Promise<TransferResult> {
  const {
    room,
    participant,
    args,
    getConsultInProgress,
    getConsultRoomName,
    getTransferSession,
    getConsultRoom,
    setConsultInProgress,
    holdParticipant,
  } = context;

  if (!getConsultInProgress()) {
    throw new Error("No consult transfer in progress to finalise");
  }

  const consultRoomName = getConsultRoomName();
  const transferSession = getTransferSession();
  const consultRoom = getConsultRoom();

  if (!consultRoomName) {
    throw new Error("Consultation room not found");
  }

  logger.info({ consultRoomName, callerRoom: room.name }, "finalising warm transfer (LiveKit pattern)");

  try {
    // Step 1: Move transfer target from consultation room to caller room
    const transferTargetIdentity = "transfer-target";
    await roomService.moveParticipant(
      consultRoomName,
      transferTargetIdentity,
      room.name!
    );

    logger.info({}, "transfer target moved to caller room");

    // Step 2: Unhold the caller so they can hear the introduction
    await holdParticipant(participant.sid!, false);

    // Step 3: Close TransferAgent session and disconnect from consultation room
    if (transferSession) {
      await transferSession.close();
    }
    if (consultRoom) {
      await consultRoom.disconnect();
    }

    // Step 4: Delete consultation room
    await roomService.deleteRoom(consultRoomName);

    logger.info({}, "consultation room cleaned up");

    // Step 5: Finalize the call record
    await finaliseBridgedCallFn();

    // Step 6: Clear the in-progress flag
    setConsultInProgress(false);

    return {
      status: "OK",
      reason: "Warm transfer completed successfully",
    };
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({ e }, "failed to finalise warm transfer");
    // Cleanup on error
    try {
      if (transferSession) {
        await transferSession.close();
      }
      if (consultRoom) {
        await consultRoom.disconnect();
      }
      if (consultRoomName) {
        await roomService.deleteRoom(consultRoomName);
      }
    } catch (cleanupError) {
      logger.error({ cleanupError }, "failed to cleanup during error");
    }
    // Always clear the flag on error
    setConsultInProgress(false);
    throw error;
  }
}

/**
 * Handles consultative transfer - starts consultation, waits for decision, then finalizes or rejects
 */
async function handleConsultativeTransfer(
  context: TransferContext,
  effectiveCallerId: string,
  effectiveAplisayId: string,
  finaliseBridgedCallFn: () => Promise<Call | null>
): Promise<TransferResult> {
  const { participant, registrationOriginated, trunkInfo } = context;
  
  // Check canRefer capability
  const canRefer = canParticipantRefer(participant, registrationOriginated, trunkInfo);
  const isSip = isSipParticipant(participant);

  // Set up promise to wait for TransferAgent decision
  let resolveDecision: (accepted: boolean, transcript?: string) => void;
  let rejectDecision: (error: Error) => void;
  const decisionPromise = new Promise<{ accepted: boolean; transcript?: string }>((resolve, reject) => {
    resolveDecision = (accepted: boolean, transcript?: string) => {
      resolve({ accepted, transcript });
    };
    rejectDecision = (error: Error) => {
      reject(error);
    };
  });

  // Add promise resolvers to context
  const consultativeContext: TransferContext = {
    ...context,
    resolveConsultativeDecision: resolveDecision!,
    rejectConsultativeDecision: rejectDecision!,
  };

  try {
    // Start consultation (this will set up the consultation room and TransferAgent)
    let startResult: TransferResult;
    if (isSip && canRefer) {
      // Case 4: Warm transfer with SIP REFER
      startResult = await handleWarmTransferWithRefer(
        consultativeContext,
        effectiveCallerId,
        effectiveAplisayId
      );
    } else {
      // Case 3: Warm transfer (LiveKit approach)
      startResult = await handleWarmTransfer(
        consultativeContext,
        effectiveCallerId,
        effectiveAplisayId
      );
    }

    // If starting consultation failed, clear flag and return error
    if (startResult.status !== "OK") {
      context.setConsultInProgress(false);
      return {
        status: "FAILED",
        reason: startResult.reason || "Failed to start consultation",
        error: startResult.error,
      };
    }

    // Wait for TransferAgent decision (with timeout)
    const timeout = 300000; // 5 minutes
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Consultation timeout - no decision received")), timeout);
    });

    const decision = await Promise.race([decisionPromise, timeoutPromise]);

    if (decision.accepted) {
      // Finalize the transfer
      const finaliseCanRefer = canParticipantRefer(participant, registrationOriginated, trunkInfo);
      const finaliseIsSip = isSipParticipant(participant);

      let finaliseResult: TransferResult;
      if (finaliseIsSip && finaliseCanRefer) {
        finaliseResult = await finaliseWarmTransferWithRefer(consultativeContext, finaliseBridgedCallFn);
      } else {
        finaliseResult = await finaliseWarmTransfer(consultativeContext, finaliseBridgedCallFn);
      }

      if (finaliseResult.status === "OK") {
        return {
          status: "OK",
          reason: "Transfer completed successfully",
        };
      } else {
        // Finalization failed - flag should already be cleared by finaliseWarmTransfer/finaliseWarmTransferWithRefer
        // But ensure it's cleared in case of error
        context.setConsultInProgress(false);
        return {
          status: "FAILED",
          reason: finaliseResult.reason || "Failed to finalize transfer",
          error: finaliseResult.error,
        };
      }
    } else {
      // Transfer was rejected - clean up and return with transcript
      await rejectWarmTransfer(consultativeContext);
      return {
        status: "FAILED",
        reason: "Transfer target declined the transfer",
        transcript: decision.transcript,
      };
    }
  } catch (error: any) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ error: err }, "Error in consultative transfer");
    
    // Clean up on error
    try {
      if (context.getConsultInProgress()) {
        await rejectWarmTransfer(consultativeContext);
      }
    } catch (cleanupError) {
      logger.error({ cleanupError }, "Error during cleanup");
    }

    return {
      status: "FAILED",
      reason: err.message || "Consultative transfer failed",
      error: err,
    };
  }
}

/**
 * Main transfer handler - routes to the appropriate transfer method
 */
export async function handleTransfer(
  context: TransferContext
): Promise<TransferResult> {
  const {
    participant,
    args,
    agent,
    calledId,
    aplisayId,
    registrationOriginated,
    sessionRef,
    call,
    instance,
    room,
    options,
    getConsultInProgress,
  } = context;

  // Guard: Check if a transfer is already in progress
  if (getConsultInProgress()) {
    logger.warn(
      { roomName: room.name, number: args.number, operation: args.operation },
      "Transfer request rejected: transfer already in progress"
    );
    return {
      status: "FAILED",
      reason: "A transfer is already in progress. Please wait for the current transfer to complete before initiating another one.",
    };
  }

  const operation = args.operation || "blind";

  // Validate and resolve transfer arguments
  const { effectiveCallerId, effectiveAplisayId } = await validateTransferArgs(
    args,
    agent,
    calledId,
    aplisayId
  );

  // Check canRefer capability (using trunk info from context)
  const canRefer = canParticipantRefer(participant, registrationOriginated, context.trunkInfo);
  const isSip = isSipParticipant(participant);

  logger.info(
    {
      args,
      number: args.number,
      operation,
      identity: participant?.sid,
      room: room.name,
      effectiveAplisayId,
      calledId,
      effectiveCallerId,
      isSip,
      canRefer,
      aplisayId,
    },
    "handling transfer"
  );

  // Helper to finalize bridged call
  const finaliseBridgedCallFn = async (): Promise<Call | null> => {
    const session = sessionRef(null);
    return finaliseBridgedCall(
      call,
      instance,
      agent,
      room,
      context.callerId,
      calledId,
      options,
      session
    );
  };

  // Route based on operation and participant capabilities
  if (operation === "blind") {
    if (isSip && canRefer) {
      // Case 2: Blind transfer using SIP REFER
      return handleBlindReferTransfer(context, finaliseBridgedCallFn);
    } else {
      // Case 1: Blind transfer by bridging
      return handleBlindBridgeTransfer(
        context,
        effectiveCallerId,
        effectiveAplisayId,
        finaliseBridgedCallFn
      );
    }
  } else if (operation === "consultative") {
    return handleConsultativeTransfer(
      context,
      effectiveCallerId,
      effectiveAplisayId,
      finaliseBridgedCallFn
    );
  } else {
    throw new Error(`Unknown transfer operation: ${operation}`);
  }
}

