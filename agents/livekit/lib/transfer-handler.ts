import { RoomServiceClient, AccessToken, VideoGrant } from "livekit-server-sdk";
import { Room, RoomEvent } from "@livekit/rtc-node";
import { voice, llm } from "@livekit/agents";
import logger from "./logger.js";
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
import {
  detachPrimaryAgentMediaAfterBridge,
  getLlmForTransferSession,
} from "./voice-session-resources.js";
import { userOwnsPhoneNumber } from "./scope.js";
import { deleteRoomWithRetry } from "./livekit-helpers.js";

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
  forceBridged?: boolean; // Force bridged transfer from phone registration endpoint options
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
 * Resolves whether the final hop of a transfer should be completed via SIP
 * REFER (true) or by bridging (false). Applies to both blind transfers and the
 * finalisation of consultative transfers.
 *
 * Origin defaults:
 *  - registration-originated SIP calls default to REFER
 *  - SIP trunk calls default to bridged (REFER only if the trunk opts in via
 *    flags.forceReferTransfer, or the legacy flags.canRefer capability flag)
 *  - WebRTC participants can never REFER
 *
 * Overrides, highest precedence first:
 *  1. Per-transfer args.forceRefer / args.forceBridged
 *  2. Endpoint / trunk options: the registration option bridged_transfer
 *     (snake_case in API/storage; surfaced in code as context.forceBridged)
 *     and trunk flags.forceReferTransfer
 *  3. Origin default above
 */
function resolveUseRefer(context: TransferContext): boolean {
  const { participant, registrationOriginated, trunkInfo, args } = context;

  // WebRTC participants cannot REFER under any circumstances.
  if (!isSipParticipant(participant)) {
    return false;
  }

  // 1. Per-transfer explicit overrides win. forceRefer beats forceBridged.
  if (args.forceRefer === true) {
    return true;
  }
  if (args.forceBridged === true) {
    return false;
  }

  // 2. Endpoint / trunk level options.
  // context.forceBridged carries the registration option bridged_transfer
  // (snake_case in API/storage, camelCase here in code).
  if (context.forceBridged === true) {
    return false;
  }
  if (
    trunkInfo?.flags?.forceReferTransfer === true ||
    trunkInfo?.flags?.canRefer === true
  ) {
    return true;
  }

  // 3. Origin default: registration => REFER, trunk => bridged.
  return registrationOriginated === true;
}

/**
 * Validates transfer arguments and resolves effective caller ID
 */
async function validateTransferArgs(
  args: TransferArgs,
  agent: Agent,
  calledId: string,
  aplisayId: string,
  opts?: {
    /** Remote party on the inbound leg (e.g. Twilio2 when middle is NTA). */
    inboundCallerId?: string;
    /** Consult/outbound will egress via the registration B2BUA (From = our DDI). */
    registrationOutbound?: boolean;
  },
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

  if (!args.callerId) {
    if (opts?.registrationOutbound) {
      // Inbound to a registration: calledId is our own PSTN — use as From on consult.
      effectiveCallerId = calledId;
    } else if (opts?.inboundCallerId) {
      // Trunk egress (e.g. Twilio): present the remote caller's CLI, not our inbound DDI.
      effectiveCallerId = opts.inboundCallerId;
    }
  }

  // Validate overridden callerId if provided
  if (args.callerId) {
    const pn: PhoneNumberInfo | null = await getPhoneEndpointByNumber(
      args.callerId
    );
    if (!pn) {
      throw new Error("Invalid callerId: number not found");
    }
    // Strict ownership check via userOwnsPhoneNumber. A direct
    // `pn.organisationId !== agent.organisationId` comparison would let any
    // no-org agent claim any other no-org tenant's outbound number as
    // caller-ID (null !== null is false in JS); userOwnsRow alone would
    // additionally refuse the legitimate no-org case where the user's
    // listener has claimed a pool number, because PhoneNumber has no userId
    // column. userOwnsPhoneNumber accepts either direct org match or
    // transitive ownership via the bound Instance — the agent-db response
    // attaches `Instance.userId/organisationId` for that branch.
    if (
      !userOwnsPhoneNumber(
        { id: agent.userId, organisationId: agent.organisationId },
        pn,
      )
    ) {
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
  detachPrimaryAgentMediaAfterBridge(session);

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
    registrationOriginated,
    b2buaGatewayIp,
    b2buaGatewayTransport,
    registrationEndpointId,
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
      callerId,
      registrationOriginated || false,
      b2buaGatewayIp,
      b2buaGatewayTransport,
      registrationEndpointId,
      context.call?.id,
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
  context: TransferContext
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
    logger.info({ participant }, "Transferring using base participant");
    const tpResult = await transferParticipant(
      room.name!,
      participant.identity!,
      args.number,
      aplisayId!,
      registrar,
      transport,
      callerId,
      context.call?.id
    );

    logger.info({ tpResult }, "transfer participant executed via SIP REFER");
    setTransferState("none", "Transfer completed successfully");
    return {
      status: "OK",
      reason: "Transfer completed successfully",
    };
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));
    // This is pretty horrid, but the transfer can appear to fail *after*
    // it has actually succeeded due to a couple of race conditions.
    // We can detect these by checking for specific error messages.
    // And then tell the caller it succeeded really.
    if (isSpuriousReferSuccess(error)) {
      logger.info(
        { message: error.message },
        "transfer failed quirk, succeeded really",
      );
      setTransferState("none", "Transfer completed (sort of) successfully");
      return {
        status: "OK",
        reason: "The transfer target was found and accepted the transfer, future calls to transfer will now fail, do not call this tool again",
      };
    } else {
      setTransferState("failed", `Transfer failed: ${error.message}`);
      throw error;
    }
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
 * LiveKit can report a SIP REFER as failed even though it actually completed,
 * via a couple of known race conditions. These error messages mean "the REFER
 * succeeded, stop retrying". Used by both the blind-refer path and the
 * consultative finalise path so neither tears the call down on a false failure.
 */
function isSpuriousReferSuccess(error: Error): boolean {
  return (
    error.message?.includes("500: Internal Server Error") === true ||
    error.message?.includes(
      "twirp error unknown: participant does not exist"
    ) === true
  );
}

/**
 * Ends a consultation call record, first persisting the TransferAgent transcript
 * as a transaction log so the consult leg has a transcript. Best-effort: a
 * failure here must never prevent the rest of transfer teardown, so all errors
 * are swallowed and logged.
 */
async function endConsultCallWithTranscript(
  consultCall: Call | null,
  agent: Agent,
  transcript: string,
  reason: string
): Promise<void> {
  if (!consultCall) {
    return;
  }
  try {
    if (transcript) {
      await createTransactionLog({
        userId: agent.userId,
        organisationId: agent.organisationId,
        callId: consultCall.id,
        type: "agent",
        data: transcript,
        isFinal: true,
      });
    }
    await consultCall.end(reason);
    logger.info(
      { consultCallId: consultCall.id },
      "ended consultation call"
    );
  } catch (e) {
    logger.error(
      { e, consultCallId: consultCall.id },
      "failed to end consultation call"
    );
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
    setCurrentBridged,
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

    // Declared before the ParticipantAttributesChanged listener below so the
    // listener can reference it safely. Previously this was a `const` initialised
    // only at the dial in Step 4, so an attribute-sync event arriving before the
    // dial promise resolved threw a temporal-dead-zone ReferenceError
    // ("Cannot access 'transferTargetParticipant' before initialization"), which
    // silently dropped any late-arriving X-Aplisay-Refer-Replaces update. Starts
    // null; the `&& transferTargetParticipant` guard in the listener no-ops until
    // Step 4 assigns the dialed participant.
    let transferTargetParticipant: any = null;

    // INSTRUMENTATION (REFER+Replaces investigation): log the transfer target's
    // SIP attributes as they sync. With includeHeaders=SIP_ALL_HEADERS on the
    // consult leg, the 200 OK headers are mapped to sip.h.* — we want to confirm
    // whether the To/From dialog tags (sip.h.to / sip.h.from) and the carrier
    // Call-ID (sip.callIDFull) actually survive the B2BUA so we can build a valid
    // Replaces. Registered before dialing so no early attribute sync is missed.
    consultRoom.on(
      RoomEvent.ParticipantAttributesChanged,
      (changedAttributes: Record<string, string>, participant: any) => {
        if (participant?.identity !== transferTargetIdentity) return;
        const sipAttrs = Object.fromEntries(
          Object.entries(participant?.attributes ?? {}).filter(([k]) =>
            k.startsWith("sip.")
          )
        );
        // The B2BUA reflects the carrier-facing Replaces via api_on_answer, which
        // may land on a dialog refresh just after the initial 200 OK snapshot.
        // Persist it here too so finalise still sees it.
        const reflected = (participant?.attributes ?? {})[
          "sip.h.x-aplisay-refer-replaces"
        ];
        if (reflected && transferTargetParticipant) {
          transferTargetParticipant.referReplaces = reflected;
        }
        logger.info(
          {
            consultRoomName,
            identity: participant?.identity,
            changedAttributes,
            sipAttributes: sipAttrs,
          },
          "consult target SIP attributes synced (REFER+Replaces investigation)"
        );
      }
    );

    // Step 4: Dial transfer target into consultation room
    const registrationConsultTrunk = Boolean(
      context.registrationEndpointId && context.b2buaGatewayIp,
    );
    transferTargetParticipant = await dialTransferTargetToConsultation(
      consultRoomName,
      args.number,
      effectiveCallerId,
      effectiveAplisayId,
      transferTargetIdentity,
      registrationConsultTrunk,
      context.b2buaGatewayIp,
      context.b2buaGatewayTransport,
      context.registrationEndpointId,
      callerId,
      context.call?.id,
    );
    setBridgedParticipant(transferTargetParticipant);
    // Record the consult target so the REFER+Replaces finalise can reference its
    // SIP dialog (best-effort; LiveKit only exposes sipCallId, not the to/from tags).
    setCurrentBridged(transferTargetParticipant);

    // Capture the consult leg's full SIP dialog identifiers from the 200 OK
    // headers (mapped to sip.h.* via includeHeaders=SIP_ALL_HEADERS) and persist
    // them on the bridged participant record so finaliseConsultativeTransfer can
    // build a valid RFC 3891 Replaces (call-id;to-tag=...;from-tag=...).
    try {
      const targetParticipant = Array.from(
        consultRoom.remoteParticipants.values()
      ).find((p: any) => p?.identity === transferTargetIdentity);
      const attrs = ((targetParticipant as any)?.attributes ?? {}) as Record<
        string,
        string
      >;
      const sipAttrs = Object.fromEntries(
        Object.entries(attrs).filter(([k]) => k.startsWith("sip."))
      );

      const parseTag = (header?: string): string | undefined =>
        header?.match(/;tag=([^;>\s]+)/i)?.[1];
      const callIdFull = attrs["sip.callIDFull"] || attrs["sip.h.call-id"];
      const toTag = parseTag(attrs["sip.h.to"]);
      const fromTag = parseTag(attrs["sip.h.from"]);
      // B2BUA path: the gateway proxies our REFER upstream to the carrier, so the
      // Replaces must describe the B2BUA<->carrier consult dialog, which only the
      // B2BUA knows. It reflects that dialog back to us as a pre-assembled
      // Replaces in X-Aplisay-Refer-Replaces. When present, prefer it verbatim.
      const referReplaces = attrs["sip.h.x-aplisay-refer-replaces"];

      if (callIdFull) transferTargetParticipant.callIdFull = callIdFull;
      if (toTag) transferTargetParticipant.toTag = toTag;
      if (fromTag) transferTargetParticipant.fromTag = fromTag;
      if (referReplaces) transferTargetParticipant.referReplaces = referReplaces;

      logger.info(
        {
          consultRoomName,
          identity: (targetParticipant as any)?.identity,
          sipCallId: transferTargetParticipant?.sipCallId,
          callIdFull,
          toTag,
          fromTag,
          referReplaces,
          sipAttributes: sipAttrs,
        },
        "consult target answered: captured SIP dialog tags for Replaces"
      );
    } catch (error) {
      logger.error({ error }, "failed to capture consult target dialog tags");
    }
    // Step 5: Create TransferAgent with conversation history
    const prevCtx = session.chatCtx;
    const ctxCopy = prevCtx.copy({
      excludeEmptyMessage: true,
      excludeInstructions: true,
      excludeFunctionCall: true,
    });

    let parentTranscript = "\n";
    try {
      for (const msg of ctxCopy.items) {
        if (msg.type === "message") {
          const role = msg.role;
          const textContent = (msg.textContent || "")
            .replace(/\\n/g, '')
            .replace(/\r?\n/g, '');
          if (role === "user") {
            parentTranscript += `> caller: ${textContent}\n`;
          } else if (role === "assistant") {
            parentTranscript += `> agent: ${textContent}\n`;
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
      llm: getLlmForTransferSession(session),
    });
    setTransferSession(transferSession);

    await transferSession.start({
      room: consultRoom,
      agent: transferAgent,
      // Don't try to record the transfer session as this causes the start to throw due to recording primary session in parallel
      record: false,
    });

    logger.info({}, "transfer agent started in consultation room");

    // Step 7: Create call record for consultation leg
    const { agent, instance, call } = context;
    const { userId, organisationId } = agent;
    // For registration-originated calls the dialable effectiveCallerId is the
    // "00000" catch-all (no useful identity). Record the registration UUID
    // instead so the consult leg correlates back to the endpoint — mirroring the
    // main inbound call record. RECORD-ONLY: effectiveCallerId itself is left
    // untouched and continues to drive the consult dial CLI above.
    const recordConsultCallerId =
      context.registrationOriginated &&
      context.registrationEndpointId &&
      (!effectiveCallerId || effectiveCallerId === "00000")
        ? context.registrationEndpointId
        : effectiveCallerId;
    const consultCallRecord = await createCall({
      parentId: call.id,
      userId,
      organisationId,
      instanceId: instance.id,
      agentId: agent.id,
      platform: "livekit",
      platformCallId: consultRoomName,
      calledId: args.number,
      callerId: recordConsultCallerId,
      modelName: agent.modelName,
      options: context.options,
      metadata: {
        ...instance.metadata,
        aplisay: {
          callerId: recordConsultCallerId,
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
        await deleteRoomWithRetry(consultRoomName);
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

    // Capture the consult transcript while the TransferAgent session is still
    // intact (it is closed below). Persisted onto the consult call record when
    // we end it, so the consult leg gets a transcript on accept too.
    const consultTranscript = transferSession
      ? getTransferAgentTranscript(transferSession)
      : "";

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

      // Build the RFC 3891 Replaces token from the consultation leg so the
      // caller's endpoint replaces that dialog instead of ringing the target
      // again. All three components (call-id;to-tag;from-tag) are required for a
      // valid Replaces; these are captured from the consult target's 200 OK
      // headers in initiateConsultativeTransfer. If the full set is unavailable
      // we degrade: a call-id-only Replaces (likely rejected upstream) or a
      // plain REFER with no Replaces at all.
      const consultTarget = context.getCurrentBridged();
      const callId = consultTarget?.callIdFull || consultTarget?.sipCallId || null;
      const toTag = consultTarget?.toTag || null;
      const fromTag = consultTarget?.fromTag || null;
      let replaces: string | null = null;
      if (consultTarget?.referReplaces) {
        // B2BUA path: use the carrier-facing Replaces the gateway reflected to us.
        replaces = consultTarget.referReplaces;
        logger.info(
          { referReplaces: replaces },
          "using B2BUA-reflected RFC 3891 Replaces (gateway-facing consult dialog)"
        );
      } else if (callId && toTag && fromTag) {
        // SBC path: the gateway is a transparent proxy, so the dialog LiveKit sees
        // is the one the referred party will replace.
        replaces = `${callId};to-tag=${toTag};from-tag=${fromTag}`;
        logger.info(
          { callId, toTag, fromTag },
          "built RFC 3891 Replaces from LiveKit-facing consult dialog tags"
        );
      } else if (callId) {
        replaces = callId;
        logger.warn(
          { callId, toTag, fromTag },
          "incomplete consult dialog tags; sending call-id-only Replaces (may be rejected upstream)"
        );
      } else {
        logger.warn(
          { consultTarget },
          "no consult dialog id available; falling back to plain REFER without Replaces"
        );
      }

      // Use SIP REFER to transfer the original participant to the transfer target.
      // LiveKit can throw a spurious failure even when the REFER actually
      // completed (same race handled in handleBlindReferTransfer). If we let that
      // propagate it skips the consult-call teardown below and orphans the
      // consult leg as "in progress" forever, so swallow the known false-failures.
      try {
        await transferParticipant(
          room.name!,
          participant.identity!,
          args.number,
          aplisayId!,
          registrar,
          transport,
          callerId,
          context.call?.id,
          replaces
        );
        logger.info({ replaces }, "transfer executed via SIP REFER (+Replaces best-effort)");
      } catch (referError: any) {
        const e =
          referError instanceof Error ? referError : new Error(String(referError));
        if (isSpuriousReferSuccess(e)) {
          logger.info(
            { message: e.message, replaces },
            "consult REFER reported failure but actually succeeded; continuing teardown"
          );
        } else {
          throw e;
        }
      }
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
    await deleteRoomWithRetry(consultRoomName);


    logger.info({}, "consultation room cleaned up");

    // Step 5: End consultation call, persisting the consult transcript captured above.
    await endConsultCallWithTranscript(
      getConsultCall(),
      agent,
      consultTranscript,
      "Transfer completed"
    );

    // Step 6: Finalize the call record.
    // Only the bridge path leaves a real two-party call in the agent's room
    // (caller <-> transfer target) that needs a bridged-call record. On the
    // REFER path the caller is referred away from the room entirely, so there
    // is nothing to bridge; creating a record there produces a phantom leg that
    // never ends. The original call is ended via the room-disconnect path.
    if (!useRefer) {
      await finaliseBridgedCallFn();
    }

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
        await deleteRoomWithRetry(consultRoomName);
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
  const consultCall = getConsultCall();
  const inProgress = getConsultInProgress();

  // Settle the consult call here even when no transfer is "in progress". The
  // accept path (finaliseConsultativeTransfer) clears the in-progress flag at
  // its very start, then performs a slow SIP REFER. When the caller disconnects
  // during that window, this handler runs from the worker shutdown path (which
  // IS awaited) while finalise's own teardown races — and loses to — the process
  // shutdown. If we returned early on !inProgress the consult call record would
  // be orphaned "in progress" forever. So the only case with nothing to do is:
  // no transfer in progress AND no unsettled consult call. consultCall.end() is
  // idempotent (_endCalled), so calling it here in addition to finalise is safe.
  if (!inProgress && (!consultCall || (consultCall as any)._endCalled)) {
    return;
  }

  logger.info(
    { reason, inProgress, consultCallId: consultCall?.id ?? null },
    "settling consultation transfer on original caller disconnect"
  );

  const consultRoomName = getConsultRoomName();
  const transferSession = getTransferSession();
  const consultRoom = getConsultRoom();

  // Capture the transcript while the TransferAgent session is still intact (it
  // is closed below). Used to give the consult call record its transcript.
  const transcript = transferSession
    ? getTransferAgentTranscript(transferSession)
    : "";

  try {
    // Heavy room/session teardown is only needed when a transfer is still in
    // progress. Once finalise has cleared the flag it owns that teardown; here
    // we just need to guarantee the consult call record is ended.
    if (inProgress) {
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
          await deleteRoomWithRetry(consultRoomName);
          logger.debug({ consultRoomName }, "deleted consultation room");
        } catch (e) {
          logger.error(
            { e, consultRoomName },
            "failed to delete consultation room"
          );
        }
      }
    }

    // Step 3: End consultation call, persisting the transcript. Idempotent, so
    // safe whether or not finalise already ended it.
    await endConsultCallWithTranscript(consultCall, agent, transcript, reason);

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
    setTransferState
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

    // End the consultation call now, while the TransferAgent session still
    // holds the transcript. The participant removal / session close below trigger
    // async hangups, and without this the consult leg is orphaned "in progress".
    const consultTranscript = transferSession
      ? getTransferAgentTranscript(transferSession)
      : "";
    await endConsultCallWithTranscript(
      getConsultCall(),
      agent,
      consultTranscript,
      finalSummary
    );

    // By default, do NOT share detailed rejection feedback with the original agent.
    // The new consultFeedback flag, when true, enables sharing the detailed summary.
    const shareFeedback = context.args?.consultFeedback === true;
    const stateDescription = shareFeedback
      ? finalSummary
      : "Transfer failed";

    logger.debug(
      { finalSummary, stateDescription, consultFeedback: shareFeedback },
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
        await deleteRoomWithRetry(consultRoomName);
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
  finaliseBridgedCallFn: () => Promise<Call | null>,
  useRefer: boolean
): Promise<TransferResult> {
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
    // Start consultation (this will set up the consultation room and TransferAgent).
    // useRefer decides whether the eventual finalisation hands the caller over
    // via SIP REFER (+?Replaces) or by bridging the transfer target into the
    // caller's room.
    let startResult: TransferResult;

    startResult = await startConsultativeTransfer(
      consultativeContext,
      effectiveCallerId,
      effectiveAplisayId,
      useRefer
    );

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
          // Finalize the transfer using the resolved mode (REFER+Replaces or bridge).
          let finaliseResult: TransferResult;
          finaliseResult = await finaliseConsultativeTransfer(
            consultativeContext,
            finaliseBridgedCallFn,
            useRefer
          );

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
  const registrationConsultTrunk = Boolean(
    context.registrationEndpointId && context.b2buaGatewayIp,
  );
  const { effectiveCallerId, effectiveAplisayId } = await validateTransferArgs(
    args,
    agent,
    calledId,
    aplisayId,
    {
      inboundCallerId: context.callerId,
      registrationOutbound: registrationConsultTrunk || registrationOriginated,
    },
  );

  // Check canRefer capability (using trunk info from context)
  const canRefer = canParticipantRefer(
    participant,
    registrationOriginated,
    context.trunkInfo
  );
  const isSip = isSipParticipant(participant);

  // Check if forceBridged is set from phone registration endpoint options
  // This overrides args.forceBridged if set to true
  const forceBridgedFromEndpoint = context.forceBridged === true;
  const effectiveForceBridged = forceBridgedFromEndpoint || args.forceBridged === true;

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
      forceBridgedFromEndpoint,
      effectiveForceBridged,
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

  // Route based on operation and the resolved transfer mode.
  // resolveUseRefer applies origin defaults (registration => REFER,
  // trunk => bridged) plus the forceRefer / forceBridged (per-transfer),
  // trunk forceReferTransfer, and registration bridged_transfer overrides.
  const useRefer = resolveUseRefer(context);

  logger.info(
    { useRefer, forceRefer: args.forceRefer, canRefer, isSip },
    "resolved transfer mode"
  );

  if (operation === "blind") {
    if (useRefer) {
      // Case 2: Blind transfer using SIP REFER
      return handleBlindReferTransfer(context);
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
      finaliseBridgedCallFn,
      useRefer
    );
  } else {
    throw new Error(`Unknown transfer operation: ${operation}`);
  }
}
