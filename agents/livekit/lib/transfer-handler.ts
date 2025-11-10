import { RoomServiceClient, AccessToken, VideoGrant, SipClient } from "livekit-server-sdk";
import { Room } from "@livekit/rtc-node";
import { voice, llm } from "@livekit/agents";
import logger from "../agent-lib/logger.js";
import { bridgeParticipant, transferParticipant } from "./telephony.js";
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
}

export interface TransferResult {
  status: "OK" | "ERROR";
  detail: string;
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
  const { room, args, setBridgedParticipant } = context;

  logger.info(
    { roomName: room.name, number: args.number },
    "executing blind bridge transfer"
  );

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
    detail: `transfer completed, session is now closed`,
  };
}

/**
 * Case 2: Blind transfer using SIP REFER
 * Used for SIP participants with canRefer capability
 */
async function handleBlindReferTransfer(
  context: TransferContext,
  finaliseBridgedCallFn: () => Promise<Call | null>
): Promise<TransferResult> {
  const { room, participant, args, aplisayId, registrationOriginated, registrationRegistrar, registrationTransport } = context;

  logger.info(
    { roomName: room.name, participant: participant?.sid, number: args.number },
    "executing blind SIP REFER transfer"
  );

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
    detail: `transfer completed, session is now closed`,
  };
}

/**
 * Case 3: Consultative warm transfer (LiveKit pattern)
 * Uses separate consultation room with TransferAgent
 * Follows: https://docs.livekit.io/sip/transfer-warm/
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
    const supervisorIdentity = "Supervisor";

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

    // Create TransferAgent with conversation history in instructions
    const transferAgent = new voice.Agent({
      instructions: `You are a supervisor assistant who can summarize the call. Here is the conversation history: ${prevConvo}`,
      tools: {}, // Transfer agent doesn't need tools
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

    // Step 7: Dial supervisor into consultation room
    const sipClient = new SipClient(
      LIVEKIT_URL!,
      LIVEKIT_API_KEY!,
      LIVEKIT_API_SECRET!
    );

    const outboundSipTrunks = await sipClient.listSipOutboundTrunk();
    const outboundSipTrunk = outboundSipTrunks.find(
      (t) => t.name === "Aplisay Outbound"
    );

    if (!outboundSipTrunk) {
      throw new Error("No livekit outbound SIP trunk found");
    }

    const origin = effectiveCallerId.replace(/^0/, "44").replace(/^(?!\+)/, "+");
    const destination = args.number.replace(/^0/, "44").replace(/^(?!\+)/, "+");

    const supervisorParticipant = await sipClient.createSipParticipant(
      outboundSipTrunk.sipTrunkId,
      destination,
      consultRoomName,
      {
        participantIdentity: supervisorIdentity,
        headers: {
          "X-Aplisay-Trunk": effectiveAplisayId,
        },
        participantName: "Supervisor",
        fromNumber: origin,
        krispEnabled: true,
        waitUntilAnswered: true,
      }
    );

    logger.info({ supervisorParticipant }, "supervisor dialed into consultation room");

    setConsultInProgress(true);

    return {
      status: "OK",
      detail: `Consult transfer started. The transfer agent is now talking to the supervisor in a consultation room. When ready, finalize the transfer to connect them with the caller.`,
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
      status: "ERROR",
      detail: `Failed to initiate warm transfer`,
      error: error,
    };
  }
}

/**
 * Finalizes a warm transfer (moves supervisor to caller room, then connects them)
 * Follows LiveKit pattern: Move supervisor from consultation room to caller room
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
    // Step 1: Move supervisor from consultation room to caller room
    const supervisorIdentity = "Supervisor";
    await roomService.moveParticipant(
      consultRoomName,
      supervisorIdentity,
      room.name!
    );

    logger.info({}, "supervisor moved to caller room");

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

    return {
      status: "OK",
      detail: `consult transfer completed, supervisor and caller are now connected`,
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
    throw error;
  }
}

/**
 * Rejects a warm transfer (hangs up supervisor, cleans up consultation room, returns to caller)
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
    "consult_reject"
  );

  try {
    // Step 1: Remove supervisor from consultation room (hangs up call)
    if (consultRoomName) {
      try {
        await roomService.removeParticipant(
          consultRoomName,
          "Supervisor"
        );
        logger.debug({}, "removed supervisor from consultation room");
      } catch (e) {
        logger.error(
          { e, consultRoomName },
          "failed to remove supervisor from consultation room"
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
    detail: `consult transfer rejected, returning to caller`,
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
    const supervisorIdentity = "Supervisor";

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

    // Create TransferAgent with conversation history in instructions
    const transferAgent = new voice.Agent({
      instructions: `You are a supervisor assistant who can summarize the call. Here is the conversation history: ${prevConvo}`,
      tools: {}, // Transfer agent doesn't need tools
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

    // Step 7: Dial supervisor into consultation room
    const sipClient = new SipClient(
      LIVEKIT_URL!,
      LIVEKIT_API_KEY!,
      LIVEKIT_API_SECRET!
    );

    const outboundSipTrunks = await sipClient.listSipOutboundTrunk();
    const outboundSipTrunk = outboundSipTrunks.find(
      (t) => t.name === "Aplisay Outbound"
    );

    if (!outboundSipTrunk) {
      throw new Error("No livekit outbound SIP trunk found");
    }

    const origin = effectiveCallerId.replace(/^0/, "44").replace(/^(?!\+)/, "+");
    const destination = args.number.replace(/^0/, "44").replace(/^(?!\+)/, "+");

    const supervisorParticipant = await sipClient.createSipParticipant(
      outboundSipTrunk.sipTrunkId,
      destination,
      consultRoomName,
      {
        participantIdentity: supervisorIdentity,
        headers: {
          "X-Aplisay-Trunk": effectiveAplisayId,
        },
        participantName: "Supervisor",
        fromNumber: origin,
        krispEnabled: true,
        waitUntilAnswered: true,
      }
    );

    logger.info({ supervisorParticipant }, "supervisor dialed into consultation room");

    setConsultInProgress(true);

    return {
      status: "OK",
      detail: `Consult transfer started with SIP REFER. The transfer agent is now talking to the supervisor in a consultation room. When ready, finalize the transfer to execute SIP REFER.`,
    };
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({ e }, "failed to initiate warm transfer with REFER");
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
      status: "ERROR",
      detail: `Failed to initiate warm transfer with REFER`,
      error: error,
    };
  }
}

/**
 * Finalizes a warm transfer (LiveKit pattern for case 4)
 * Moves supervisor to caller room, unholds caller, then cleans up consultation
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
    // Step 1: Move supervisor from consultation room to caller room
    const supervisorIdentity = "Supervisor";
    await roomService.moveParticipant(
      consultRoomName,
      supervisorIdentity,
      room.name!
    );

    logger.info({}, "supervisor moved to caller room");

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

    return {
      status: "OK",
      detail: `warm transfer completed, supervisor and caller are now connected`,
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
    throw error;
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
  } = context;

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
  } else if (operation === "consult_start") {
    if (isSip && canRefer) {
      // Case 4: Warm transfer with SIP REFER
      return handleWarmTransferWithRefer(
        context,
        effectiveCallerId,
        effectiveAplisayId
      );
    } else {
      // Case 3: Warm transfer (LiveKit approach)
      return handleWarmTransfer(
        context,
        effectiveCallerId,
        effectiveAplisayId
      );
    }
  } else if (operation === "consult_finalise") {
    // Re-check canRefer for finalise (using trunk info from context)
    const finaliseCanRefer = canParticipantRefer(participant, registrationOriginated, context.trunkInfo);
    const finaliseIsSip = isSipParticipant(participant);

    if (finaliseIsSip && finaliseCanRefer) {
      // Case 4: Finalise warm transfer with SIP REFER
      return finaliseWarmTransferWithRefer(context, finaliseBridgedCallFn);
    } else {
      // Case 3: Finalise warm transfer (standard)
      return finaliseWarmTransfer(context, finaliseBridgedCallFn);
    }
  } else if (operation === "consult_reject") {
    return rejectWarmTransfer(context);
  } else {
    throw new Error(`Unknown transfer operation: ${operation}`);
  }
}

