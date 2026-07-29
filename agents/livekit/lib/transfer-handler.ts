import { RoomServiceClient, AccessToken, VideoGrant } from "livekit-server-sdk";
import { Room, RoomEvent } from "@livekit/rtc-node";
import { voice, llm } from "@livekit/agents";
import logger from "./logger.js";
import {
  bridgeParticipant,
  transferParticipant,
  dialTransferTargetToConsultation,
  chargeableOutboundTrunkId,
} from "./telephony.js";
import {
  getPhoneEndpointByNumber,
  getPhoneEndpointById,
  createCall,
  createTransactionLog,
  saveUsage,
  type PhoneNumberInfo,
  type PhoneRegistrationInfo,
  type TrunkInfo,
} from "./api-client.js";
import { resolveUsageVendors } from "./usage-vendors.js";
import { sipAttribute } from "./sip-attributes.js";
import { makeUsageMeter, type UsageMeter } from "./usage-meter.js";
import { resolveVoiceMode } from "./voice-mode.js";
import type { ParticipantInfo, SipParticipant, TransferArgs } from "./types.js";
import type { Agent, Call, Instance } from "./api-client.js";
import {
  detachPrimaryAgentMediaAfterBridge,
  getLlmForTransferSession,
} from "./voice-session-resources.js";
import { userOwnsPhoneNumber, userOwnsRow } from "./scope.js";
import { deleteRoomWithRetry } from "./livekit-helpers.js";
import { closeSessionBounded } from "./utils.js";
import type { UltravoxFirstSpeakerSettings } from "../plugins/ultravox/src/realtime/api_proto.js";
import {
  parseBridgedTransferMap,
  armBridgedTransferWatch,
  type BridgedTakeoverRuntime,
} from "./bridged-transfer-to-agent.js";
import {
  parseBridgedTranscribeOption,
  armBridgedTranscription,
  type BridgeTranscriptionHandle,
} from "./bridge-transcription.js";

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

/**
 * Per-consult usage meters, keyed by the consult Call record. The consult
 * session is wired during transfer initiation but flushed in the separate
 * completion path, so the meter is stashed here to bridge the two. WeakMap so a
 * dropped/errored consult's meter is collected with its Call.
 */
const consultUsageMeters = new WeakMap<Call, UsageMeter>();

/**
 * How long the TransferAgent waits for the dialled target to speak before opening
 * the conversation itself. Comfortably inside the eval target's 6s inactivity
 * timeout, and long enough to cover answer-to-greeting latency on a carrier trunk
 * (~1.5s observed) without leaving a live person listening to silence.
 */
const CONSULT_FIRST_SPEAKER_FALLBACK_DELAY = "3s";

/**
 * Upper bound on `transferSession.close()`. An Ultravox session can hang in close()
 * indefinitely: `AgentSession.close()` awaits `activity.drain()`, which only exits
 * once every speech task has settled, and the tool-reply speech task awaits
 * `RealtimeSession.generateReply()` — a bare Future that Ultravox settles only when
 * it begins the NEXT generation. On a consult leg whose peer has already gone away
 * that next generation never comes.
 *
 * This matters well beyond the consult leg: `destroyInProgressTransfer` is awaited
 * from the PRIMARY call's disconnect handling, immediately before `call.end()` and
 * `process.exit(0)`. An unbounded close there strands the primary call record too —
 * never ended, its agent-concurrency slot never released. Same hazard, same bound,
 * as the agent-handover close in voice-agent-runtime.
 */
const TRANSFER_SESSION_CLOSE_TIMEOUT_MS = 8_000;

/**
 * Close the TransferAgent session without ever blocking the caller. Bounded (see
 * {@link TRANSFER_SESSION_CLOSE_TIMEOUT_MS}) and non-throwing: every call site is a
 * teardown path where the room, the call record and the process shutdown behind it
 * must proceed regardless.
 */
function closeTransferSessionBounded(
  transferSession: Pick<voice.AgentSession, "close"> | null | undefined,
  context: string
): Promise<void> {
  return closeSessionBounded(
    transferSession,
    TRANSFER_SESSION_CLOSE_TIMEOUT_MS,
    (e) =>
      logger.warn(
        { e: e.message, context },
        "transfer session close failed/timed out; continuing teardown"
      )
  );
}

/**
 * `firstSpeakerSettings` is an Ultravox-realtime concept. The consult session
 * inherits whatever LLM the primary call uses, which may be another realtime
 * provider or a plain text LLM, so both helpers are no-ops unless the model
 * actually implements the one-shot override.
 */
type ConsultFirstSpeakerCapable = {
  setNextSessionFirstSpeaker?: (s: UltravoxFirstSpeakerSettings) => void;
  clearNextSessionFirstSpeaker?: () => void;
};

function setNextSessionFirstSpeaker(
  consultLlm: unknown,
  firstSpeakerSettings: UltravoxFirstSpeakerSettings
): void {
  (consultLlm as ConsultFirstSpeakerCapable)?.setNextSessionFirstSpeaker?.(
    firstSpeakerSettings
  );
}

function clearNextSessionFirstSpeaker(consultLlm: unknown): void {
  (consultLlm as ConsultFirstSpeakerCapable)?.clearNextSessionFirstSpeaker?.();
}

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
  registrationUsername: string | null | undefined; // Registration trunk username (e.g. 8092); used as calling number toward the gateway
  registrationEndpointId: string | null | undefined; // Registration endpoint ID from sipHXAplisayPhoneregistration
  b2buaGatewayIp: string | null | undefined; // B2BUA gateway IP from sipHXLkRealIp
  b2buaGatewayTransport: string | null | undefined; // B2BUA gateway transport from sipHXLkTransport
  aLegEncrypted: boolean; // Whether the inbound A-leg media is encrypted (SRTP), from sipHXLkMediaEncryption; drives B-leg trunk media policy
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
  // Live human→agent takeover capability registered by the voice runtime
  // (options.bridgedTransferToAgent); null/absent when no runtime is up
  // (e.g. transfer-only fallback mode).
  getBridgedTakeover?: () => BridgedTakeoverRuntime | null;
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
  // Accept dotted (what LiveKit actually sends) as well as the camelCase
  // aliases — see lib/sip-attributes.ts.
  const attrs = participant.attributes;
  return !!(
    sipAttribute(attrs, "calledNumber") ||
    sipAttribute(attrs, "callerNumber") ||
    sipAttribute(attrs, "aplisayTrunk")
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
interface RegistrationEgress {
  registrationEndpointId: string;
  b2buaGatewayIp: string;
  b2buaGatewayTransport: string;
  registrationUsername: string | null | undefined;
}

async function validateTransferArgs(
  args: TransferArgs,
  agent: Agent,
  calledId: string,
  aplisayId: string
): Promise<{
  effectiveCallerId: string;
  effectiveAplisayId: string;
  /** Set when the caller-ID is a phone_registration: the B-leg must egress via its B2BUA gateway. */
  registrationEgress?: RegistrationEgress;
}> {
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
  let registrationEgress: RegistrationEgress | undefined;

  // Validate overridden callerId if provided
  if (args.callerId) {
    const pn: PhoneNumberInfo | null = await getPhoneEndpointByNumber(
      args.callerId
    );
    if (pn) {
      // ---- Owned phone_numbers (E.164) caller-ID ----
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
    } else {
      // ---- Phone-registration caller-ID ----
      // A registration endpoint can originate a transfer (e.g. a WebRTC origin
      // dialling out via a SIP-registration trunk). Its caller identity is the
      // registration ROW, not an owned phone_numbers entry, so getPhoneEndpoint
      // ByNumber (phone_numbers only) returns null and we resolve it by id.
      const reg: PhoneRegistrationInfo | null = await getPhoneEndpointById(
        args.callerId
      );
      if (!reg) {
        throw new Error("Invalid callerId: number not found");
      }
      // Org-ownership gate, as for the e164 path. phone_registrations are
      // organisation-scoped (no userId column), so userOwnsRow matches on the
      // shared organisationId — which the agent-db `?id=` response must include.
      if (
        !userOwnsRow(
          { id: agent.userId, organisationId: agent.organisationId },
          reg,
        )
      ) {
        throw new Error(
          "Invalid callerId: registration not owned by this organisation"
        );
      }
      if (reg.outbound === false) {
        throw new Error(
          "Invalid callerId: outbound not enabled on this registration"
        );
      }
      const regCallerNumber = reg.options?.displayNumber || reg.username || "";
      if (!regCallerNumber) {
        throw new Error(
          "Invalid callerId: registration has no outbound caller number"
        );
      }
      // The B-leg of a registration caller-ID transfer must egress via the
      // registration's B2BUA gateway — same as the registration-originated path
      // in worker.ts — so the bridge/consult dial routes to the registrar with
      // the X-Aplisay-PhoneRegistration header and the registration username as
      // the calling number, NOT the default outbound trunk.
      const b2buaGatewayIp = String(reg.b2buaId ?? "").trim();
      if (!b2buaGatewayIp) {
        throw new Error(
          "Invalid callerId: registration has no B2BUA gateway (b2buaId)"
        );
      }
      registrationEgress = {
        registrationEndpointId: args.callerId,
        b2buaGatewayIp,
        b2buaGatewayTransport: "tcp", // LiveKit↔B2BUA transport; mirrors worker.ts
        registrationUsername: reg.username ?? null,
      };
      effectiveCallerId = regCallerNumber;
    }
  }

  return {
    effectiveCallerId,
    effectiveAplisayId,
    ...(registrationEgress ? { registrationEgress } : {}),
  };
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
  setBridgedCallRecord?: (call: Call | null) => void,
  outboundTrunkId?: string
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
      // The bridged tail leg is the carried dial to the transfer target — chargeable
      // on our public trunk unless the original call is registration-originated (then
      // the target is reached via the customer's own B2BUA/PBX).
      outboundTrunkId,
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
 * Arm the post-bridge watches (options.bridgedTransferToAgent — the
 * human→agent DTMF watch — and options.bridgedTransferTranscribe — the
 * bridged-segment transcription) once a bridged transfer has completed:
 * the blind bridge and the bridged consultative finalise both land here.
 * No-op unless at least one option is set and the bridged call record
 * exists. Transcription arms standalone (no bta map, no runtime needed);
 * the DTMF watch additionally requires the voice runtime's takeover
 * capability (transfer-only fallback mode has none). The pre-transfer
 * transcript snapshot is taken here, at bridge time, because the
 * superseded agent session may be torn down while the humans talk.
 */
function armBridgedTransferToAgentWatch(
  context: TransferContext,
  bridgedCallRecord: Call | null,
  targetIdentity: string,
): void {
  const targets = parseBridgedTransferMap(context.options);
  const transcribe = parseBridgedTranscribeOption(context.options);
  if (!targets && !transcribe) return;
  if (!bridgedCallRecord) {
    logger.warn(
      { roomName: context.room?.name },
      "bridged transfer watch: no bridged call record; watch not armed",
    );
    return;
  }
  const rtcRoom: Room | null | undefined = context.ctx?.room;
  if (!rtcRoom || !context.room?.name) {
    logger.warn(
      { hasRtcRoom: Boolean(rtcRoom), roomName: context.room?.name },
      "bridged transfer watch: no connected room; watch not armed",
    );
    return;
  }

  // Bridged-segment transcription (options.bridgedTransferTranscribe): one
  // STT stream per bridged human, entries logged against the bridged call
  // record. Best-effort — a failure here must not disturb the bridge or
  // the DTMF watch below. Arms standalone when no bta map is configured;
  // the record's ending (participant disconnect handlers / takeover) flushes
  // any batched entries.
  let bridgeTranscription: BridgeTranscriptionHandle | null = null;
  if (transcribe) {
    try {
      bridgeTranscription = armBridgedTranscription({
        room: rtcRoom,
        roomName: context.room.name!,
        callerIdentity: context.participant?.identity ?? null,
        targetIdentity,
        bridgedCall: bridgedCallRecord,
        agent: context.agent,
        transcribe,
        streamLog: context.instance?.streamLog === true,
      });
    } catch (e) {
      logger.warn(
        { e, roomName: context.room?.name },
        "bridgedTransferTranscribe: failed to arm transcription (continuing without it)",
      );
    }
  }

  if (!targets) return;
  const runtime = context.getBridgedTakeover?.();
  if (!runtime) {
    logger.warn(
      { roomName: context.room?.name },
      "bridgedTransferToAgent configured but no takeover runtime registered; watch not armed",
    );
    return;
  }
  // Same inter-digit timeout as ordinary DTMF input buffering.
  const dtmfTimeoutOption = context.options?.dtmfTimeout;
  const dtmfTimeoutMs =
    typeof dtmfTimeoutOption === "number" && dtmfTimeoutOption >= 0
      ? Math.max(250, dtmfTimeoutOption)
      : 1500;
  armBridgedTransferWatch({
    room: rtcRoom,
    roomName: context.room.name!,
    targetIdentity,
    callerIdentity: context.participant?.identity ?? null,
    targets,
    dtmfTimeoutMs,
    bridgedCall: bridgedCallRecord,
    agent: context.agent,
    historyText: runtime.getConversationHistoryText(),
    bridgeTranscription,
    runtime,
    setBridgedParticipant: context.setBridgedParticipant,
    setBridgedCallRecord: context.setBridgedCallRecord,
    removeParticipant: (name, identity) =>
      roomService.removeParticipant(name, identity),
  });
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
    registrationUsername,
    aLegEncrypted,
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
      aLegEncrypted,
      registrationUsername,
    );

    logger.info({ p }, "new participant created (blind bridge)");
    setBridgedParticipant(p);
    const bridgedCallRecord = await finaliseBridgedCallFn();

    // Human→agent hand-back (options.bridgedTransferToAgent) and bridged-
    // segment transcription (options.bridgedTransferTranscribe): watch the
    // transfer target's DTMF / transcribe both humans for the life of the
    // bridge. No-op when neither option is set.
    armBridgedTransferToAgentWatch(
      context,
      bridgedCallRecord,
      p.participantIdentity,
    );

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
    if (
      error.message?.includes("500: Internal Server Error") ||
      error.message?.includes("twirp error unknown: participant does not exist")
    ) {
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

    // Step 4: Move to "dialling" BEFORE placing the SIP call. This is the
    // dead-air gap the confidence tone must cover, and transfer_status should
    // report an in-progress dial rather than "none" while the target rings.
    // (Previously this was only set after the target answered, so the tone
    // never covered the dial — and never played at all when the dial failed.)
    context.setTransferState("dialling", "Dialling transfer target...");

    // Holds the consult target across the attribute-sync listener below and the
    // dial. Starts null so the listener's `&& transferTargetParticipant` guard
    // no-ops until the dial assigns it (avoids a temporal-dead-zone error).
    let transferTargetParticipant: any = null;

    // The Aplisay B2BUA reflects the gateway-facing consult dialog's RFC 3891
    // Replaces back to us on the consult leg as the X-Aplisay-Refer-Replaces
    // header (surfaced as sip.h.x-aplisay-refer-replaces once
    // includeHeaders=SIP_ALL_HEADERS is set on the dial). It can arrive on a
    // post-answer dialog refresh, after the initial 200 OK snapshot, so also
    // catch it here. finaliseConsultativeTransfer uses it to build the ?Replaces
    // on the caller's REFER so the target is not rung twice (attended transfer).
    // See aplisay-b2bua/freeswitch/scripts/refer_reflect.lua.
    consultRoom.on(
      RoomEvent.ParticipantAttributesChanged,
      (_changed: Record<string, string>, participant: any) => {
        if (participant?.identity !== transferTargetIdentity) return;
        const reflected = (participant?.attributes ?? {})[
          "sip.h.x-aplisay-refer-replaces"
        ];
        if (reflected && transferTargetParticipant) {
          transferTargetParticipant.referReplaces = reflected;
        }
      }
    );

    // Dial transfer target into consultation room
    transferTargetParticipant = await dialTransferTargetToConsultation(
      consultRoomName,
      args.number,
      effectiveCallerId,
      effectiveAplisayId,
      transferTargetIdentity,
      context.registrationOriginated,
      context.b2buaGatewayIp,
      context.b2buaGatewayTransport,
      context.registrationEndpointId,
      callerId,
      context.call?.id,
      context.aLegEncrypted,
      context.registrationUsername,
    );
    setBridgedParticipant(transferTargetParticipant);

    // Record the consult target so finaliseConsultativeTransfer can build the
    // REFER ?Replaces from its dialog, and capture the consult leg's SIP dialog
    // identifiers from the 200 OK headers (mapped to sip.h.* via
    // includeHeaders=SIP_ALL_HEADERS): the B2BUA-reflected pre-assembled Replaces
    // (X-Aplisay-Refer-Replaces) for the proxy path, plus the LiveKit-facing
    // Call-ID/to-tag/from-tag as the SBC-path fallback.
    context.setCurrentBridged(transferTargetParticipant);
    try {
      const targetParticipant = Array.from(
        consultRoom.remoteParticipants.values()
      ).find((p: any) => p?.identity === transferTargetIdentity);
      const attrs = ((targetParticipant as any)?.attributes ?? {}) as Record<
        string,
        string
      >;
      const parseTag = (header?: string): string | undefined =>
        header?.match(/;tag=([^;>\s]+)/i)?.[1];
      const callIdFull = attrs["sip.callIDFull"] || attrs["sip.h.call-id"];
      const toTag = parseTag(attrs["sip.h.to"]);
      const fromTag = parseTag(attrs["sip.h.from"]);
      const referReplaces = attrs["sip.h.x-aplisay-refer-replaces"];
      if (callIdFull) transferTargetParticipant.callIdFull = callIdFull;
      if (toTag) transferTargetParticipant.toTag = toTag;
      if (fromTag) transferTargetParticipant.fromTag = fromTag;
      if (referReplaces) transferTargetParticipant.referReplaces = referReplaces;
      logger.info(
        { consultRoomName, callIdFull, toTag, fromTag, referReplaces },
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

You have just dialled this person and they have only this second answered. Let them speak first - wait until you have heard them greet you before you say anything. If they stay silent for a few seconds, open with a brief greeting yourself.

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
    const consultLlm = getLlmForTransferSession(session);
    const transferSession = new voice.AgentSession({ llm: consultLlm });
    setTransferSession(transferSession);

    // Persist the consultation conversation onto the consult CALL RECORD.
    // Historically the consult leg had NO transcript wiring at all (only usage
    // metering below), so its transcript was always empty. Mirror the main
    // session's ConversationItemAdded -> transaction-log capture, but target the
    // consult call: buffer each turn and attach the buffer as the consult call's
    // batched transaction logs, which consultCall.end() flushes on every terminal
    // path (accept / reject / init-fail / destroy). See api-client call.end and
    // finaliseConsultativeTransfer/endConsultationRecord.
    const consultTranscriptLogs: Array<{
      userId: string;
      organisationId: string;
      callId: string;
      type: string;
      data: string;
      isFinal: boolean;
      createdAt: Date;
    }> = [];
    transferSession.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      ({
        item: { type, role, content },
        createdAt,
      }: voice.ConversationItemAddedEvent) => {
        if (type !== "message") return;
        const text = content.join("");
        if (!text) return;
        consultTranscriptLogs.push({
          userId: context.agent.userId,
          organisationId: context.agent.organisationId,
          // Resolved once the consult call exists; turns captured before the
          // record is created are back-filled where it is attached below.
          callId: context.getConsultCall()?.id ?? "",
          type: role === "user" ? "user" : "agent",
          data: JSON.stringify(text),
          isFinal: true,
          createdAt: createdAt ? new Date(createdAt) : new Date(),
        });
      },
    );

    // Meter the consult leg's llm/tts/stt onto the consult call record. The
    // consult LLM is the primary's, so resolve vendors from the primary model.
    // Per-session, so it never double-counts the primary call's usage.
    const consultUsageMeter = makeUsageMeter({
      getCall: () => context.getConsultCall(),
      usageVendors: resolveUsageVendors(context.agent, context.agent.modelName),
      voiceMode: resolveVoiceMode(context.agent.modelName, context.agent.options),
      fallbackDetail: context.agent.modelName,
    });
    consultUsageMeter.wire(transferSession);

    // The consult leg DIALS the target, so the target answers and greets first —
    // the opposite posture to the inbound primary call whose model instance this
    // session shares. Left on the model default (FIRST_SPEAKER_AGENT) the
    // TransferAgent opens its own turn ~0.5s after connect, straight over the
    // target's greeting, which Ultravox then discards as barge-in: the consult
    // transcript loses that turn and the agent never hears who it is talking to.
    // Ultravox owns the opening turn, so express it there, for THIS session only.
    // `fallback` keeps a silent target (voicemail, IVR, someone waiting for us to
    // speak) from producing dead air; `prompt` rather than `text` so the greeting is
    // generated in the TransferAgent's own voice and is not echoed back to us as a
    // synthetic user turn.
    setNextSessionFirstSpeaker(consultLlm, {
      user: {
        fallback: {
          delay: CONSULT_FIRST_SPEAKER_FALLBACK_DELAY,
          prompt:
            "The person you dialled has not said anything yet. Greet them briefly and explain that you are calling about transferring a caller to them.",
        },
      },
    });

    try {
      await transferSession.start({
        room: consultRoom,
        agent: transferAgent,
        // Don't try to record the transfer session as this causes the start to throw due to recording primary session in parallel
        record: false,
      });
    } finally {
      // start() consumes the one-shot when it builds the realtime session; if it
      // threw before that, drop the override so it cannot land on an unrelated
      // session later (e.g. a primary-agent handover on the same model).
      clearNextSessionFirstSpeaker(consultLlm);
    }

    logger.info({}, "transfer agent started in consultation room");

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
      // The consult leg is a carried dial to the transfer target — chargeable on our
      // public trunk unless registration-originated (target via the customer B2BUA).
      outboundTrunkId: chargeableOutboundTrunkId(context.registrationOriginated),
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
    // Attach the buffered consult transcript so consultCall.end() flushes it, and
    // back-fill callId for any turns captured before this record existed.
    for (const consultLog of consultTranscriptLogs) {
      if (!consultLog.callId) consultLog.callId = consultCallRecord.id;
    }
    (consultCallRecord as any).batchedTransactionLogs = consultTranscriptLogs;
    consultUsageMeters.set(consultCallRecord, consultUsageMeter);
    logger.info(
      { consultCallId: consultCallRecord.id, consultRoomName },
      "created consultation call record"
    );

    // Step 8: Start the consultation call (transfer target has answered).
    // State is already "dialling" from before the dial; it stays in the
    // tone's active set through this brief setup window until "talking" below.
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
    // Close the TransferAgent session if it got as far as starting. Initiation can
    // fail after transferSession.start() (e.g. creating the consult call record), and
    // nothing downstream closes it: this path leaves consultInProgress false, so both
    // destroyInProgressTransfer and the background reject handler short-circuit. The
    // session and its Ultravox call would otherwise stay live and billed.
    await closeTransferSessionBounded(
      context.getTransferSession(),
      "initiation-failure"
    );
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

  /**
   * End the consult CALL RECORD. Hoisted out of the try below so the error path can
   * reach it too: every other terminal path ends the record, and if this one does not
   * the row is stranded `live=true` forever — its agent-concurrency slot never
   * released and the transcript `end()` flushes never written.
   *
   * `call.end()` is idempotent (its `_endCalled` latch returns the original promise),
   * so calling this on a record another path already ended is a no-op. It deliberately
   * does NOT flush the consult usage meter: metering on the non-accept terminal paths
   * is a billing behaviour change, not teardown hygiene, and is out of scope here.
   */
  const endConsultRecord = async (reason: string): Promise<void> => {
    const consultCall = getConsultCall();
    if (!consultCall) {
      return;
    }
    await consultCall.end(reason);
    logger.info({ consultCallId: consultCall.id }, "ended consultation call");
  };

  try {
    const transferTargetIdentity = "transfer-target";

    // Clear the in-progress flag, but do NOT mark the transfer "none"/completed
    // here. Terminal state is owned by the background accept_transfer handler,
    // which sets "none" only once this function RETURNS ok (reached only after the
    // REFER/move actually completes) and "failed" if it throws. Marking "none"
    // up-front — as the old code did — reported success while the REFER was still
    // in flight (or about to 408), so the middle agent told the caller they were
    // connected when they were not. During the REFER flight transfer_status
    // correctly stays at the in-progress "talking" set when the target answered.
    setConsultInProgress(false);

    // Stop the TransferAgent bot and flush + end the consult CALL RECORD. This is
    // DB/bookkeeping only — it does NOT touch the consult SIP dialog or room. Kept
    // separate from room teardown because on the REFER+Replaces path the consult
    // dialog must stay alive until the caller's REFER (whose ?Replaces names that
    // dialog) has been honoured by the carrier.
    const endConsultationRecord = async () => {
      // Deliberately NOT awaited, and deliberately still ahead of the flush below.
      // close() drains the session, and that drain is what emits the TransferAgent's
      // closing turn into the batched transcript — starting it here and flushing
      // concurrently is what gives that turn a chance to land in `end()`'s snapshot.
      // The far more common hazard is close() hanging (see
      // TRANSFER_SESSION_CLOSE_TIMEOUT_MS), so it must never gate this path.
      if (transferSession) {
        void closeTransferSessionBounded(transferSession, "finalise");
      }
      const consultCall = getConsultCall();
      if (consultCall) {
        const consultMeter = consultUsageMeters.get(consultCall);
        if (consultMeter) {
          await consultMeter.flush(true);
          consultUsageMeters.delete(consultCall);
        }
        await endConsultRecord("Transfer completed");
      }
    };

    // Delete the consult room (drops any remaining consult SIP leg). Best-effort.
    const deleteConsultationRoom = async () => {
      await deleteRoomWithRetry(consultRoomName);
      logger.info({}, "consultation room cleaned up");
    };

    if (useRefer) {
      // Case 4: SIP REFER the original caller to the transfer target (attended
      // transfer when a Replaces token is available).
      //
      // End the consult call RECORD BEFORE the (blocking) REFER — transferParticipant
      // does not return until the caller's SIP leg leaves the room, and the
      // caller-disconnect graceful shutdown then races the record teardown
      // (destroyInProgressTransfer no-ops because setConsultInProgress(false) ran
      // above), which previously orphaned the consult record. BUT keep the consult
      // SIP dialog ALIVE: the REFER carries ?Replaces naming the B2BUA<->carrier
      // consult dialog, which the carrier can only honour while that dialog still
      // exists — so the room is deleted AFTER the REFER, not before.
      await endConsultationRecord();

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

      // Build the RFC 3891 Replaces from the consult leg so the caller's endpoint
      // replaces the consultation dialog instead of ringing the target again.
      // Prefer the B2BUA-reflected value (correct for the proxy-refer path);
      // otherwise fall back to the LiveKit-facing dialog tags (SBC path), then to
      // a call-id-only Replaces, then to a plain REFER.
      const consultTarget = context.getCurrentBridged();
      const callId = consultTarget?.callIdFull || consultTarget?.sipCallId || null;
      const toTag = consultTarget?.toTag || null;
      const fromTag = consultTarget?.fromTag || null;
      let replaces: string | null = null;
      if (consultTarget?.referReplaces) {
        replaces = consultTarget.referReplaces;
        logger.info(
          { referReplaces: replaces },
          "using B2BUA-reflected RFC 3891 Replaces (gateway-facing consult dialog)"
        );
      } else if (callId && toTag && fromTag) {
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
      // LiveKit can report a spurious failure even when the REFER actually
      // completed (same race as handleBlindReferTransfer); swallow the known
      // false-failures so a successful transfer is not marked as failed.
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
        logger.info(
          { replaces },
          "transfer executed via SIP REFER (+Replaces best-effort)"
        );
      } catch (referError: any) {
        const e =
          referError instanceof Error ? referError : new Error(String(referError));
        if (
          e.message?.includes("500: Internal Server Error") ||
          e.message?.includes("twirp error unknown: participant does not exist")
        ) {
          logger.info(
            { message: e.message, replaces },
            "consult REFER reported failure but actually succeeded; continuing"
          );
        } else {
          throw e;
        }
      }

      // Cleanup only AFTER the REFER — by now the Replaces has taken over (and
      // BYE'd) the consult dialog, or the caller has left. Best-effort; may race
      // the caller-disconnect shutdown, which is fine since the record is ended.
      await deleteConsultationRoom();
    } else {
      // Case 3: Move the transfer target from the consultation room into the
      // caller room. The target must still be present, so move FIRST, then tear
      // the consultation down and emit the telephony:bridged-call child for the
      // in-room caller<->target bridge.
      await roomService.moveParticipant(
        consultRoomName,
        transferTargetIdentity,
        room.name!
      );

      logger.info({}, "transfer target moved to caller room");

      await endConsultationRecord();
      await deleteConsultationRoom();

      const bridgedCallRecord = await finaliseBridgedCallFn();

      // Human→agent hand-back (options.bridgedTransferToAgent) and bridged-
      // segment transcription (options.bridgedTransferTranscribe): the target
      // is now bridged into the caller room under the consult identity —
      // watch its DTMF / transcribe both humans for the life of the bridge.
      // No-op when neither option is set.
      armBridgedTransferToAgentWatch(
        context,
        bridgedCallRecord,
        transferTargetIdentity,
      );
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
    // Cleanup on error. This path is NOT recoverable by anything downstream:
    // setConsultInProgress(false) above disarms destroyInProgressTransfer, and the
    // background reject handler is gated on the same flag — so if the consult record
    // is not ended here it is never ended at all. Reachable in practice on the
    // bridged branch, where roomService.moveParticipant runs before the record is
    // ended and can throw when the target has already gone.
    try {
      await endConsultRecord(`Transfer finalisation failed: ${error.message}`);
    } catch (endError) {
      logger.error(
        { endError, consultCallId: getConsultCall()?.id },
        "failed to end consultation call during finalise error cleanup"
      );
    }
    try {
      await closeTransferSessionBounded(transferSession, "finalise-error");
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
    // Step 1: Close TransferAgent session and disconnect from consultation room.
    // Bounded: this function is awaited from the PRIMARY call's disconnect handling,
    // immediately before that call's own end() and process.exit(0), so a close() that
    // hangs strands the primary call record as well as this one.
    await closeTransferSessionBounded(transferSession, "destroy");
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

    // Step 3: End consultation call and create transaction logs for transcript.
    // Gated on the CALL only: the record must be ended even when there is no transfer
    // session to read a transcript from, or it is stranded live=true with its
    // concurrency slot held.
    if (consultCall) {
      try {
        const transcript = transferSession
          ? getTransferAgentTranscript(transferSession)
          : "";
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
    // Step 1: End consultation call and create transaction logs for transcript.
    //         We do this first because later steps cause an async hangup of the
    //         transfer target. On the rejection path there is no other code path
    //         that ends the consultation call record (destroyInProgressTransfer
    //         short-circuits once setConsultInProgress(false) is set below), so
    //         it must happen here or the record is left started but never ended.

    if (!finalSummary) {
      // If no transcript available, use default message
      finalSummary = "Transfer target declined the transfer";
    }

    const consultCall = getConsultCall();
    if (consultCall) {
      try {
        if (transferSession) {
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
        }
        await consultCall.end(finalSummary);
        logger.info(
          { consultCallId: consultCall.id },
          "ended consultation call"
        );
      } catch (e) {
        logger.error({ e }, "error ending consultation call");
      }
    }

    setConsultInProgress(false);

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

    // Step 2: Close TransferAgent session and disconnect from consultation room.
    // Bounded — a rejected consult's peer is typically already gone, and the room
    // teardown and caller hand-back behind this must not wait on a hung close().
    await closeTransferSessionBounded(transferSession, "reject");
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
    // Start consultation (this will set up the consultation room and
    // TransferAgent). useRefer decides how the eventual finalisation hands the
    // caller over: SIP REFER (caller sent to the target, LiveKit drops out of
    // the media path) or bridge (target moved into the caller's room).
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
          // Finalize the transfer using the resolved mode (REFER or bridge).
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
  const { effectiveCallerId, effectiveAplisayId, registrationEgress } =
    await validateTransferArgs(args, agent, calledId, aplisayId);

  // A registration caller-ID must egress via the registration's B2BUA gateway
  // (X-Aplisay-PhoneRegistration header + the registration username as the
  // calling number), NOT the default outbound trunk. Apply it onto the context
  // so BOTH the blind-bridge and consultative dial paths pick it up — they read
  // these fields from context (telephony.ts bridgeParticipant / consult dialler).
  // WebRTC origins still bridge: canParticipantRefer returns false for non-SIP
  // participants regardless of registrationOriginated.
  if (registrationEgress) {
    context.registrationOriginated = true;
    context.registrationEndpointId = registrationEgress.registrationEndpointId;
    context.b2buaGatewayIp = registrationEgress.b2buaGatewayIp;
    context.b2buaGatewayTransport = registrationEgress.b2buaGatewayTransport;
    context.registrationUsername = registrationEgress.registrationUsername;
  }

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
  // Human-to-agent transfers (options.bridgedTransferToAgent): while the map
  // is set, the transfer target's DTMF must remain observable AFTER the
  // handover, so transfers are forced onto the bridged path — a SIP REFER
  // hands the call off-platform where no DTMF can be seen. Overrides the
  // REFER resolution for both blind transfers and the consultative finalise.
  const bridgedTransferToAgent = parseBridgedTransferMap(options) !== null;
  // Bridged-segment transcription (options.bridgedTransferTranscribe)
  // likewise needs the media to stay on-platform — the humans' audio tracks
  // must remain observable in the room — so it forces the bridged path too.
  const bridgedTransferTranscribe =
    parseBridgedTranscribeOption(options) !== null;
  const effectiveForceBridged =
    forceBridgedFromEndpoint ||
    args.forceBridged === true ||
    bridgedTransferToAgent ||
    bridgedTransferTranscribe;

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
      bridgedTransferToAgent,
      bridgedTransferTranscribe,
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
      context.setBridgedCallRecord,
      chargeableOutboundTrunkId(context.registrationOriginated)
    );
  };

  // Route based on operation and participant capabilities.
  // useRefer: complete the final hop via SIP REFER when the participant is a
  // REFER-capable SIP leg (registration endpoints default to canRefer=true) and
  // bridging has not been forced (forceBridged / options.forceBridged). This now
  // governs BOTH blind and consultative transfers, so a REFER-capable
  // consultative transfer hands the caller to the target instead of bridging
  // them inside the LiveKit room — and therefore does not emit a
  // telephony:bridged-call child.
  const useBridged = effectiveForceBridged;
  const useRefer = isSip && canRefer && !useBridged;

  logger.info(
    { operation, isSip, canRefer, useBridged, useRefer },
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
