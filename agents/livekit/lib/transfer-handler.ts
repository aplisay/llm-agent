import { RoomServiceClient, AccessToken, VideoGrant } from "livekit-server-sdk";
import { Room, RoomEvent } from "@livekit/rtc-node";
import { voice, llm } from "@livekit/agents";
import logger from "../agent-lib/logger.js";
import {
  bridgeParticipant,
  transferParticipant,
  dialTransferTargetToConsultation,
} from "./telephony.js";
import {
  getPhoneEndpointByNumber,
  getPhoneEndpointById,
  createCall,
  createTransactionLog,
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

export type TransferState =
  | "none"
  | "dialling"
  | "talking"
  | "rejected"
  | "failed";

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
  getCurrentBridged: () => SipParticipant | null;
  setCurrentBridged: (p: SipParticipant | null) => void;
  // Consultation room state for warm transfers
  setConsultRoomName: (roomName: string | null) => void;
  getConsultRoomName: () => string | null;
  setTransferSession: (session: voice.AgentSession | null) => void;
  getTransferSession: () => voice.AgentSession | null;
  setConsultRoom: (room: Room | null) => void;
  getConsultRoom: () => Room | null;
  setConsultCall: (call: Call | null) => void;
  getConsultCall: () => Call | null;
  // Transfer state tracking
  setTransferState: (state: TransferState, description: string) => void;
  getTransferState: () => { state: TransferState; description: string };
  // Bridged call record setter
  setBridgedCallRecord: (call: Call | null) => void;
  // Promise resolvers for consultative transfer decision
  resolveConsultativeDecision?: (
    accepted: boolean,
    transcript?: string,
    reason?: string
  ) => void;
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
    logger.debug(
      { trunkId: trunkInfo.id, canRefer, flags: trunkInfo.flags },
      "Checked canRefer from trunk flags"
    );
    return canRefer;
  }

  // No trunk info, default to false
  logger.debug({}, "No trunk info available, assuming canRefer=false");
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
  // Validate that transfer number matches the agent's outboundCallFilter if specified
  if (agent.options?.outboundCallFilter) {
    const filterRegexp = new RegExp(agent.options.outboundCallFilter);
    if (!filterRegexp.test(args.number)) {
      throw new Error(
        `Invalid number: transfer target ${args.number} does not match the agent's outbound call filter pattern`
      );
    }
  } else {
    // Fallback to default UK validation if no filter is specified
    if (!args.number.match(/^(\+44|44|0)[1237]\d{6,15}$/)) {
      throw new Error(
        "Invalid number: only UK geographic and mobile numbers are supported currently as transfer targets"
      );
    }
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
    if (pn?.organisationId !== agent.organisationId) {
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
  session: voice.AgentSession | null,
  setBridgedCallRecord?: (call: Call | null) => void
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
      await roomService.updateRoomMetadata(
        room.name!,
        JSON.stringify({ bridgedCallId: bridgedCallRecord.id })
      );
      // Update the bridged call record in the worker
      if (setBridgedCallRecord) {
        setBridgedCallRecord(bridgedCallRecord);
      }
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
  const {
    room,
    args,
    setBridgedParticipant,
    setConsultInProgress,
    setTransferState,
    callerId,
  } = context;

  logger.info(
    { roomName: room.name, number: args.number },
    "executing blind bridge transfer"
  );

  try {
    // Mark transfer as in progress
    setConsultInProgress(true);
    setTransferState("dialling", "Dialling transfer target...");

    const p = await bridgeParticipant(
      room.name!,
      args.number,
      effectiveAplisayId,
      effectiveCallerId,
      callerId
    );

    logger.info({ p }, "new participant created (blind bridge)");
    setBridgedParticipant(p);
    await finaliseBridgedCallFn();

    setTransferState("none", "Transfer completed successfully");
    return {
      status: "OK",
      reason: "Transfer completed successfully",
    };
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));
    setTransferState("failed", `Transfer failed: ${error.message}`);
    throw error;
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
  const {
    room,
    participant,
    args,
    aplisayId,
    callerId,
    registrationOriginated,
    registrationRegistrar,
    registrationTransport,
    setConsultInProgress,
    setTransferState,
  } = context;

  logger.info(
    { roomName: room.name, participant: participant?.sid, number: args.number },
    "executing blind SIP REFER transfer"
  );

  try {
    // Mark transfer as in progress
    setConsultInProgress(true);
    setTransferState("dialling", "Initiating SIP REFER transfer...");

    // Determine registrar and transport for the transfer
    let registrar: string | null = null;
    let transport: string | null = null;

    // If the original call was from a registration endpoint, use its registrar/transport
    if (registrationOriginated && registrationRegistrar) {
      registrar = registrationRegistrar;
      transport = registrationTransport || null;
      logger.info(
        { registrar, transport },
        "Using registrar/transport from registration-originated call"
      );
    }

    const tpResult = await transferParticipant(
      room.name!,
      participant.identity!,
      args.number,
      aplisayId!,
      registrar,
      transport,
      callerId
    );

    logger.info({ tpResult }, "transfer participant executed via SIP REFER");
    await finaliseBridgedCallFn();

    setTransferState("none", "Transfer completed successfully");
    return {
      status: "OK",
      reason: "Transfer completed successfully",
    };
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));
    setTransferState("failed", `Transfer failed: ${error.message}`);
    throw error;
  } finally {
    // Always clear the in-progress flag, even if transfer fails
    setConsultInProgress(false);
  }
}

/**
 * Helper function to get transcript from TransferAgent session
 */
function getTransferAgentTranscript(
  transferSession: voice.AgentSession
): string {
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
 * Helper function to generate a summary from transcript for rejection reason
 * Extracts key information about why the transfer was rejected
 */
function generateRejectionSummary(
  transcript: string,
  explicitReason?: string
): string {
  // If there's an explicit reason provided, use it
  if (explicitReason && explicitReason.trim()) {
    return explicitReason.trim();
  }

  // If transcript is empty, return generic message
  if (!transcript || !transcript.trim()) {
    return "Transfer target declined the transfer";
  }

  // If transcript is short (less than 200 chars), use it directly
  if (transcript.length <= 200) {
    return transcript;
  }

  // For longer transcripts, try to extract the last few exchanges
  // which likely contain the rejection reason
  const lines = transcript.split("\n");
  const lastLines = lines.slice(-6).join("\n"); // Last 6 lines (roughly last 3 exchanges)

  // If the last lines are still too long, truncate
  if (lastLines.length > 300) {
    return lastLines.substring(0, 297) + "...";
  }

  return lastLines;
}

/**
 * Common function to start a consultative transfer consultation
 * Sets up consultation room, TransferAgent, and dials transfer target
 */
async function startConsultativeTransfer(
  context: TransferContext,
  effectiveCallerId: string,
  effectiveAplisayId: string,
  useRefer: boolean = false
): Promise<TransferResult> {
  const {
    room,
    args,
    sessionRef,
    setBridgedParticipant,
    setConsultInProgress,
    setConsultRoomName,
    setTransferSession,
    setConsultRoom,
    callerId,
  } = context;

  const session = sessionRef(null);
  if (!session) {
    throw new Error("Agent session is required for warm transfer");
  }

  logger.info(
    { roomName: room.name, number: args.number, useRefer },
    `executing warm transfer (LiveKit pattern${
      useRefer ? " with SIP REFER" : ""
    })`
  );

  try {

    // Step 1: Create consultation room
    const consultRoomName = `consult-${room.name}-${Date.now()}`;
    const transferAgentIdentity = "transfer-agent";
    const transferTargetIdentity = "transfer-target";

    // Step 2: Generate token for TransferAgent
    const accessToken = new AccessToken(LIVEKIT_API_KEY!, LIVEKIT_API_SECRET!, {
      identity: transferAgentIdentity,
    });

    const videoGrant: VideoGrant = {
      room: consultRoomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    };
    accessToken.addGrant(videoGrant);
    const token = await accessToken.toJwt();

    // Step 3: Create and connect consultation room
    const consultRoom = new Room();
    await consultRoom.connect(LIVEKIT_URL!, token);
    setConsultRoomName(consultRoomName);
    setConsultRoom(consultRoom);

    logger.info({ consultRoomName }, "consultation room created and connected");

    // Step 4: Dial transfer target into consultation room
    const transferTargetParticipant = await dialTransferTargetToConsultation(
      consultRoomName,
      args.number,
      effectiveCallerId,
      effectiveAplisayId,
      transferTargetIdentity,
      context.registrationOriginated,
      context.b2buaGatewayIp,
      context.b2buaGatewayTransport,
      context.registrationEndpointId,
      callerId
    );
    setBridgedParticipant(transferTargetParticipant);
    // Step 5: Create TransferAgent with conversation history
    const prevCtx = session.chatCtx;
    const ctxCopy = prevCtx.copy({
      excludeEmptyMessage: true,
      excludeInstructions: true,
      excludeFunctionCall: true,
    });

    let parentTranscript = "";
    try {
      for (const msg of ctxCopy.items) {
        if (msg.type === "message") {
          const role = msg.role;
          const textContent = msg.textContent || "";
          if (role === "user") {
            parentTranscript += `Customer: ${textContent}\n`;
          } else if (role === "assistant") {
            parentTranscript += `Assistant: ${textContent}\n`;
          }
        }
      }
    } catch (error) {
      logger.error({ error }, "Error copying chat context");
    }

    // Determine the transfer prompt to use:
    // 1. Check for transferPrompt in args (specific transfer override)
    // 2. Fall back to agent.options.transferPrompt (agent-level option)
    // 3. Fall back to default hardwired prompt
    const defaultTransferPromptTemplate = `You are a transfer assistant helping with a call transfer. Here is the conversation history with the caller: ${parentTranscript}

You are now speaking with the person that it has been decided to transfer the call to based on the previous Conversation, and you should act as if you were 
the agent involved in this conversation with full knowledge of the conversation history.
Your role is to:
1. Summarize the call history for the transfer target
2. Ask if they want to accept the transfer and speak with the caller
3. If they accept, call the accept_transfer function
4. If they decline, call the reject_transfer function with a detailed reason parameter that summarizes your conversation with the transfer target and explains why they declined. This summary will be provided to the original agent, so make it informative and clear.

Be helpful, informal, but respectful and concise as if talking to a colleague in a company.`;

    // Get the prompt from args, agent options, or use default
    const transferPrompt =
      args.transferPrompt ||
      context.agent.options?.transferPrompt ||
      defaultTransferPromptTemplate;

    // Replace ${parentTranscript} placeholder if present
    const finalTransferPrompt = transferPrompt.replace(
      /\$\{parentTranscript\}/g,
      parentTranscript
    );

    // Create TransferAgent with conversation history and tools to accept/reject transfer
    const transferAgent = new voice.Agent({
      instructions: finalTransferPrompt,
      tools: {
        accept_transfer: llm.tool({
          description:
            "Accept the transfer and connect the transfer target to the caller. Use this when the transfer target agrees to take the call.",
          parameters: {
            type: "object",
            properties: {
              reason: {
                type: "string",
                description: "The reason for accepting the transfer if any",
              },
            },
          },
          execute: async () => {
            logger.info({}, "TransferAgent called accept_transfer");
            if (context.resolveConsultativeDecision) {
              context.resolveConsultativeDecision(true);
            }
            return JSON.stringify({
              success: true,
              message:
                "Transfer accepted. Connecting transfer target to caller...",
            });
          },
        }),
        reject_transfer: llm.tool({
          description:
            "Reject the transfer and return the caller to the original agent. Use this when the transfer target declines to take the call. IMPORTANT: The reason parameter should include a summary of your conversation with the transfer target explaining why they declined the transfer. This summary will be provided to the original agent.",
          parameters: {
            type: "object",
            properties: {
              reason: {
                type: "string",
                description:
                  "A summary of the conversation with the transfer target explaining why they declined the transfer. This should include key points from your discussion and the specific reason(s) they gave for not accepting the transfer.",
              },
            },
            required: ["reason"],
          },
          execute: async (args: { reason: string }) => {
            logger.info(
              { reason: args.reason },
              "TransferAgent called reject_transfer"
            );
            // Get transcript for logging/transaction records, but use the explicit reason for the summary
            const transferSession = context.getTransferSession();
            const transcript = transferSession
              ? getTransferAgentTranscript(transferSession)
              : "";
            if (context.resolveConsultativeDecision) {
              logger.debug("resolving consultative decision");
              // Use the explicit reason from the transfer agent - it should already contain a summary
              context.resolveConsultativeDecision(
                false,
                transcript,
                args.reason
              );
            }
            return JSON.stringify({
              success: true,
              message:
                "Transfer rejected. Returning caller to original agent...",
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
      // Don't try to record the transfer session as this causes the start to throw due to recording primary session in parallel
      record: false,
    });

    logger.info({}, "transfer agent started in consultation room");
    transferSession?.generateReply({ userInput: 'announce yourself and explain why you are calling' });

    // Step 7: Create call record for consultation leg
    const { agent, instance, call } = context;
    const { userId, organisationId } = agent;
    const consultCallRecord = await createCall({
      parentId: call.id,
      userId,
      organisationId,
      instanceId: instance.id,
      agentId: agent.id,
      platform: "livekit",
      platformCallId: consultRoomName,
      calledId: args.number,
      callerId: effectiveCallerId,
      modelName: agent.modelName,
      options: context.options,
      metadata: {
        ...instance.metadata,
        aplisay: {
          callerId: effectiveCallerId,
          calledId: args.number,
          transferConsultation: true,
          originalCallId: call.id,
        },
      },
    });
    context.setConsultCall(consultCallRecord);
    logger.info(
      { consultCallId: consultCallRecord.id, consultRoomName },
      "created consultation call record"
    );

    // Step 8: Update state to dialling
    context.setTransferState("dialling", "Dialling transfer target...");

    // Step 9: Start the consultation call (transfer target has answered)
    await consultCallRecord.start();
    logger.info(
      { consultCallId: consultCallRecord.id },
      "started consultation call"
    );

    // Update state to talking (transfer target has answered)
    context.setTransferState("talking", "Speaking with transfer target...");

    // Step 11: Listen for transfer target disconnect in consultation room
    consultRoom.on(RoomEvent.ParticipantDisconnected, async (p: any) => {
      // Check if the disconnected participant is the transfer target
      if (p?.info?.identity === transferTargetIdentity) {
        // Sometimes callback fires while we are already in the process of closing. Do nothing.
        if (!context.getConsultInProgress()) {
          return;
        }
        logger.info(
          {
            participant: p?.info,
            context_resolve_decision: context.resolveConsultativeDecision,
           },
          "Transfer target disconnected from consultation room"
        );

        // Reject the transfer if decision hasn't been made yet
        // Note: If the transfer target disconnects before the transfer agent can call reject_transfer,
        // we use a simple disconnect message. The transfer agent should normally call reject_transfer
        // with a detailed reason before the target disconnects.
        if (context.resolveConsultativeDecision) {
          const transferSession = context.getTransferSession();
          const transcript = transferSession
            ? getTransferAgentTranscript(transferSession)
            : "";
          // Use simple disconnect message - no transcript processing here
          // The transfer agent should have called reject_transfer with a reason before disconnect
          context.resolveConsultativeDecision(
            false,
            transcript,
            "Transfer target disconnected"
          );
        }
      }
    });

    setConsultInProgress(true);

    return {
      status: "OK",
      reason: useRefer
        ? "Consultation started successfully with SIP REFER"
        : "Consultation started successfully",
    };
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({ e, useRefer }, "failed to initiate warm transfer");
    // Clean up consultation room if it was created
    const consultRoomName = context.getConsultRoomName();
    if (consultRoomName) {
      try {
        await roomService.deleteRoom(consultRoomName);
      } catch (cleanupError) {
        logger.error({ cleanupError }, "failed to cleanup consultation room");
      }
    }
    // Clean up consultation call if it was created
    const consultCall = context.getConsultCall();
    if (consultCall) {
      try {
        await consultCall.end("Transfer initiation failed");
        logger.info(
          { consultCallId: consultCall.id },
          "ended consultation call due to error"
        );
      } catch (cleanupError) {
        logger.error({ cleanupError }, "failed to cleanup consultation call");
      }
    }
    return {
      status: "FAILED",
      reason: `Failed to initiate warm transfer${
        useRefer ? " with REFER" : ""
      }: ${error.message}`,
      error: error,
    };
  }
}


/**
 * Common function to finalize a consultative transfer
 * Moves transfer target to caller room (or uses SIP REFER if useRefer=true), then cleans up
 */
async function finaliseConsultativeTransfer(
  context: TransferContext,
  finaliseBridgedCallFn: () => Promise<Call | null>,
  useRefer: boolean = false
): Promise<TransferResult> {
  const {
    room,
    participant,
    args,
    agent,
    aplisayId,
    callerId,
    registrationOriginated,
    registrationRegistrar,
    registrationTransport,
    getConsultInProgress,
    getConsultRoomName,
    getTransferSession,
    getConsultRoom,
    getConsultCall,
    setBridgedParticipant,
    setConsultInProgress,
    setTransferState,
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

  logger.info(
    { consultRoomName, callerRoom: room.name, useRefer },
    "finalising warm transfer"
  );

  try {
    const transferTargetIdentity = "transfer-target";

    // Clear the in-progress flag and update state
    setConsultInProgress(false);
    setTransferState("none", "Transfer completed successfully");

    if (useRefer) {
      // Case 4: Use SIP REFER to transfer the original caller to the transfer target
      // Determine registrar and transport for the transfer
      let registrar: string | null = null;
      let transport: string | null = null;

      // If the original call was from a registration endpoint, use its registrar/transport
      if (registrationOriginated && registrationRegistrar) {
        registrar = registrationRegistrar;
        transport = registrationTransport || null;
        logger.info(
          { registrar, transport },
          "Using registrar/transport from registration-originated call"
        );
      }

      // Use SIP REFER to transfer the original participant to the transfer target
      await transferParticipant(
        room.name!,
        participant.identity!,
        args.number,
        aplisayId!,
        registrar,
        transport,
        callerId
      );

      logger.info({}, "transfer executed via SIP REFER");
    } else {
      // Case 3: Move transfer target from consultation room to caller room
      await roomService.moveParticipant(
        consultRoomName,
        transferTargetIdentity,
        room.name!
      );

      logger.info({}, "transfer target moved to caller room");
    }

    // Step 3: Close TransferAgent session and disconnect from consultation room
    if (transferSession) {
      transferSession.close();
    }

    // Step 4: Delete consultation room
    await roomService.deleteRoom(consultRoomName);


    logger.info({}, "consultation room cleaned up");

    // Step 5: End consultation call and create transaction logs for transcript
    const consultCall = getConsultCall();
    if (consultCall) {
      await consultCall.end("Transfer completed");
      logger.info({ consultCallId: consultCall.id }, "ended consultation call");
    }

    // Step 6: Finalize the call record
    await finaliseBridgedCallFn();

    return {
      status: "OK",
      reason: useRefer
        ? "Warm transfer completed successfully"
        : "Consultative transfer completed successfully",
    };
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({ e, useRefer }, "failed to finalise warm transfer");
    setConsultInProgress(false);
    setTransferState(
      "failed",
      `Transfer finalization failed: ${error.message}`
    );
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
 * Destroys any in-progress transfer - cleans up consultation room, ends consultation call, etc.
 * This should be called when the original caller hangs up to ensure proper cleanup.
 *
 * @param getConsultInProgress - Function to check if a transfer is in progress
 * @param getConsultRoomName - Function to get the consultation room name
 * @param getTransferSession - Function to get the TransferAgent session
 * @param getConsultRoom - Function to get the consultation room
 * @param getConsultCall - Function to get the consultation call record
 * @param setConsultInProgress - Function to clear the in-progress flag
 * @param agent - Agent info (for userId/organisationId for transaction logs)
 * @param reason - Reason for destroying the transfer (default: "Original caller disconnected")
 */
export async function destroyInProgressTransfer(
  getConsultInProgress: () => boolean,
  getConsultRoomName: () => string | null,
  getTransferSession: () => voice.AgentSession | null,
  getConsultRoom: () => Room | null,
  getConsultCall: () => Call | null,
  setConsultInProgress: (value: boolean) => void,
  agent: Agent,
  reason: string = "Original caller disconnected",
  setTransferState?: (state: TransferState, description: string) => void
): Promise<void> {
  if (!getConsultInProgress()) {
    // No transfer in progress, nothing to clean up
    return;
  }

  logger.info(
    { reason },
    "destroying in-progress transfer due to original caller disconnect"
  );

  const consultRoomName = getConsultRoomName();
  const transferSession = getTransferSession();
  const consultRoom = getConsultRoom();
  const consultCall = getConsultCall();

  try {
    // Step 1: Close TransferAgent session and disconnect from consultation room
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

    // Step 2: Delete consultation room
    if (consultRoomName) {
      try {
        await roomService.deleteRoom(consultRoomName);
        logger.debug({ consultRoomName }, "deleted consultation room");
      } catch (e) {
        logger.error(
          { e, consultRoomName },
          "failed to delete consultation room"
        );
      }
    }

    // Step 3: End consultation call and create transaction logs for transcript
    if (consultCall && transferSession) {
      try {
        const transcript = getTransferAgentTranscript(transferSession);
        if (transcript) {
          const { userId, organisationId } = agent;
          await createTransactionLog({
            userId,
            organisationId,
            callId: consultCall.id,
            type: "agent",
            data: transcript,
            isFinal: true,
          });
          logger.info(
            { consultCallId: consultCall.id },
            "created transaction log for consultation transcript"
          );
        }
        await consultCall.end(reason);
        logger.info(
          { consultCallId: consultCall.id },
          "ended consultation call"
        );
      } catch (e) {
        logger.error({ e }, "error ending consultation call");
      }
    }

    // Step 4: Clear the in-progress flag and reset state
    if (getConsultInProgress()) {
      setConsultInProgress(false);
      if (setTransferState) {
        setTransferState(
          "none",
          "Transfer cancelled due to original caller disconnect"
        );
      }
      logger.info({}, "in-progress transfer destroyed");
    }
  } catch (e) {
    logger.error({ e }, "error during transfer destruction");
    // Still clear the flag even if cleanup fails
    setConsultInProgress(false);
    if (setTransferState) {
      setTransferState("failed", "Transfer cleanup failed");
    }
  }
}

/**
 * Rejects a warm transfer (hangs up transfer target, cleans up consultation room, returns to caller)
 * @param context - Transfer context
 * @param rejectionSummary - Optional summary of why the transfer was rejected (will be generated from transcript if not provided)
 */
export async function rejectConsultativeTransfer(
  context: TransferContext,
  rejectionSummary?: string
): Promise<TransferResult> {
  const {
    room,
    participant,
    agent,
    getConsultInProgress,
    getConsultRoomName,
    getTransferSession,
    getConsultRoom,
    getConsultCall,
    setConsultInProgress,
    setTransferState,
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

  // Initialize summary - will be generated from transcript if not provided
  // If a summary is provided, use it directly (it should already be a proper summary from the transfer agent)
  let finalSummary = rejectionSummary;
  logger.debug(
    { rejectionSummary, finalSummary },
    "rejectConsultativeTransfer: initialized finalSummary"
  );

  try {
    // Step 1: End consultation call and create transaction logs for transcript
    //         we do this first because later steps will likely cause an async
    //         hangup which will cause the consultation call to be ended through
    //         a different path.

    if (!finalSummary) {
      // If no transcript available, use default message
      finalSummary = "Transfer target declined the transfer";
    }

    setConsultInProgress(false);

    // If confidentialConsult is enabled, suppress the detailed rejection summary
    // to prevent confidential information from the transfer target reaching the original agent
    const isConfidential = context.args?.confidentialConsult === true;
    const stateDescription = isConfidential
      ? "Transfer failed"
      : finalSummary;

    logger.debug(
      { finalSummary, stateDescription, isConfidential },
      "Setting transfer state to rejected"
    );
    setTransferState("rejected", stateDescription);

    // Step 1: Remove transfer target from consultation room (hangs up call)
    if (consultRoomName) {
      try {
        await roomService.removeParticipant(consultRoomName, "transfer-target");
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
        logger.error(
          { e, consultRoomName },
          "failed to delete consultation room"
        );
      }
    }

  } catch (e) {
    logger.error({ e }, "error during consult rejection cleanup");
  }

  return {
    status: "OK",
    reason: "Consultative transfer rejected, caller returned",
  };
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
  const canRefer = canParticipantRefer(
    participant,
    registrationOriginated,
    trunkInfo
  );
  const isSip = isSipParticipant(participant);

  // Set up promise to wait for TransferAgent decision
  let resolveDecision: (
    accepted: boolean,
    transcript?: string,
    reason?: string
  ) => void;
  let rejectDecision: (error: Error) => void;
  const decisionPromise = new Promise<{
    accepted: boolean;
    transcript?: string;
    reason?: string;
  }>((resolve, reject) => {
    resolveDecision = (
      accepted: boolean,
      transcript?: string,
      reason?: string
    ) => {
      resolve({ accepted, transcript, reason });
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
    // TODO: Temporarily disabled REFER method for consultative transfers due to LiveKit issue
    // When fixed, restore: if (isSip && canRefer) to use Case 4 (REFER) for registration-originated calls
    let startResult: TransferResult;

    startResult = await startConsultativeTransfer(
      consultativeContext,
      effectiveCallerId,
      effectiveAplisayId,
      false // canRefer && isSip && !useBridged
    );
    // }

    // If starting consultation failed, clear flag and return error
    if (startResult.status !== "OK") {
      context.setConsultInProgress(false);
      context.setTransferState(
        "failed",
        startResult.reason || "Failed to start consultation"
      );
      return {
        status: "FAILED",
        reason: startResult.reason || "Failed to start consultation",
        error: startResult.error,
      };
    }

    // For consultative transfers, return immediately after consultation starts
    // The transfer will continue in the background, and the agent can check status with transfer_status
    // Continue processing the transfer asynchronously
    (async () => {
      try {
        // Wait for TransferAgent decision (with timeout)
        const timeout = 180000; //  minutes
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(new Error("Consultation timeout - no decision received")),
            timeout
          );
        });

        const decision = await Promise.race([decisionPromise, timeoutPromise]);

        if (decision.accepted) {
          // Finalize the transfer
          // TODO: Temporarily disabled REFER method for consultative transfers due to LiveKit issue

          let finaliseResult: TransferResult;
          finaliseResult = await finaliseConsultativeTransfer(
            consultativeContext,
            finaliseBridgedCallFn,
            false
          );
          // }

          if (finaliseResult.status === "OK") {
            context.setTransferState("none", "Transfer completed successfully");
            logger.info(
              {},
              "Consultative transfer completed successfully in background"
            );
          } else {
            // Finalization failed
            context.setConsultInProgress(false);
            context.setTransferState(
              "failed",
              finaliseResult.reason || "Failed to finalize transfer"
            );
            logger.error(
              { reason: finaliseResult.reason },
              "Consultative transfer finalization failed in background"
            );
          }
        } else {
          // Transfer was rejected - use explicit reason from transfer agent's reject_transfer call
          // The transfer agent should have provided a detailed reason summarizing the conversation
          const rejectionSummary =
            decision.reason || "Transfer target declined the transfer";
          logger.debug(
            {
              decisionReason: decision.reason,
              rejectionSummary,
              hasTranscript: !!decision.transcript,
            },
            "About to call rejectConsultativeTransfer with rejection summary"
          );
          await rejectConsultativeTransfer(consultativeContext, rejectionSummary);
          logger.info(
            {
              transcript: decision.transcript,
              reason: decision.reason,
              summary: rejectionSummary,
            },
            "Consultative transfer rejected in background"
          );
        }
      } catch (error: any) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(
          { error: err },
          "Error in background consultative transfer"
        );

        // Clean up on error
        try {
          if (context.getConsultInProgress()) {
            await rejectConsultativeTransfer(consultativeContext);
          }
        } catch (cleanupError) {
          logger.error({ cleanupError }, "Error during cleanup");
        }

        context.setTransferState(
          "failed",
          err.message || "Consultative transfer failed"
        );
      }
    })();

    // Return immediately - transfer continues in background
    return {
      status: "OK",
      reason: "Consultation started. Use transfer_status to check progress.",
    };
  } catch (error: any) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ error: err }, "Error starting consultative transfer");

    context.setTransferState(
      "failed",
      err.message || "Failed to start consultation"
    );
    context.setConsultInProgress(false);

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
      reason:
        "A transfer is already in progress. Please wait for the current transfer to complete before initiating another one.",
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
  const canRefer = canParticipantRefer(
    participant,
    registrationOriginated,
    context.trunkInfo
  );
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
      forceBridged: args.forceBridged,
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
      session,
      context.setBridgedCallRecord
    );
  };

  // Route based on operation and participant capabilities
  // Check if forceBridged is set to override REFER capability
  const useBridged = args.forceBridged === true;
  
  if (operation === "blind") {
    if (isSip && canRefer && !useBridged) {
      // Case 2: Blind transfer using SIP REFER
      return handleBlindReferTransfer(context, finaliseBridgedCallFn);
    } else {
      // Case 1: Blind transfer by bridging (forced or when REFER not available)
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
