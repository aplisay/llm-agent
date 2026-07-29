// Type definitions for the LiveKit agent worker
// Import and re-export API types from api-client
import type {
  Instance,
  Agent,
  AgentFunction,
  Call,
  CallMetadata,
  OutboundInfo,
} from './api-client.js';
import { type ParticipantInfo } from "livekit-server-sdk";

// Re-export ParticipantInfo for convenience
export { ParticipantInfo };

/**
 * Result of the `hangup` builtin, as handed back to the model.
 *
 * The model MUST get a non-empty result. `onHangup` previously returned void,
 * which serialises to an empty tool result; a realtime model reads that as "my
 * request went nowhere" and retries immediately — the mechanism behind the
 * observed 337-call hangup loop. `detail` also tells the model not to keep
 * talking, since the call is on its way down.
 */
export interface HangupResult {
  status: "OK";
  detail: string;
}

/**
 * Tears the call down when the deferred-hangup path cannot. Registered by the
 * voice runtime (which owns `cleanupAndClose`) into the worker scope that owns
 * the hangup latch, mirroring `registerBridgedTakeover`. Cleared with null on
 * teardown.
 */
export type HangupExecutor = () => void;

// The return type from SipClient.createSipParticipant - this is what bridgeParticipant returns
export interface SipParticipant {
  participantId: string;
  participantIdentity: string;
  roomName: string;
  sipCallId: string;
  // Full SIP dialog identifiers captured from the consult leg's 200 OK headers
  // (via includeHeaders=SIP_ALL_HEADERS -> sip.h.*). Used to build an RFC 3891
  // Replaces for the SBC (transparent-proxy) telephony path, where the dialog
  // LiveKit sees is the same one the referred party will replace.
  callIdFull?: string;
  toTag?: string;
  fromTag?: string;
  // Pre-assembled RFC 3891 Replaces ("call-id;to-tag=...;from-tag=...") reflected
  // back by the Aplisay B2BUA on its gateway-facing consult leg, via the
  // X-Aplisay-Refer-Replaces header (surfaced as sip.h.x-aplisay-refer-replaces).
  // On the B2BUA path the REFER is proxied upstream to the carrier, so the
  // Replaces must describe the B2BUA<->carrier dialog, not the LiveKit-facing one.
  referReplaces?: string;
}
import { voice } from "@livekit/agents";



import type { TrunkInfo } from './api-client.js';

export interface CallScenario {
  instance: Instance;
  agent: Agent | null;
  participant: ParticipantInfo | null;
  existingBridge: ParticipantInfo | null;
  callerId: string;
  calledId: string;
  aplisayId: string;
  callId: string;
  callMetadata: CallMetadata;
  outboundCall: boolean;
  outboundInfo: OutboundInfo | null;
  registrationOriginated?: boolean;
  trunkInfo?: TrunkInfo | null;
  registrationRegistrar?: string | null;
  registrationTransport?: string | null;
  registrationUsername?: string | null; // Registration trunk username (e.g. 8092); used as calling number toward the gateway
  registrationEndpointId?: string | null;
  b2buaGatewayIp?: string | null;
  b2buaGatewayTransport?: string | null;
  aLegEncrypted?: boolean; // Whether the inbound A-leg media is encrypted (SRTP); drives B-leg transfer trunk media policy
  forceBridged?: boolean;
  // All X- headers from the inbound SIP INVITE, as { "x-header-name": value }
  // (keys lowercased). Surfaced to the agent via metadata.aplisay.sipHeaders.
  // Only populated for inbound SIP calls (empty {} for outbound / WebRTC).
  sipHeaders?: Record<string, string>;
}

export interface JobMetadata {
  callId?: string;
  callerId?: string;
  calledId?: string;
  instanceId?: string;
  aplisayId?: string;
  outbound?: boolean;
  callMetadata?: CallMetadata;
  [key: string]: any;
}

export interface SetupCallParams<TContext = any, TRoom = any> {
  ctx: TContext;
  room: TRoom;
  instance: Instance;
  agent: Agent;
  callerId: string;
  calledId: string;
  aplisayId: string;
  callId: string;
  callMetadata: CallMetadata;
  userId: string;
  organisationId: string;
  modelName: string;
  options: any;
  // Preferred API used by current code
  modelRef: (model: voice.Agent | null) => voice.Agent | null;
  sessionRef: (session: voice.AgentSession | null) => voice.AgentSession | null;
  setBridgedParticipant: (participant: SipParticipant | null) => void;
  requestHangup: () => void;
  // consult transfer state management
  setConsultInProgress: (value: boolean) => void;
  getConsultInProgress: () => boolean;
  // True when this is an org-originated OUTBOUND (originate API) call — the main
  // leg is then carried on our public trunk and destination-billed (unless the CLI
  // is a registration, handled by registrationOriginated). Absent/false for inbound.
  outbound?: boolean;
  registrationOriginated?: boolean;
  trunkInfo?: TrunkInfo | null;
  registrationRegistrar?: string | null;
  registrationTransport?: string | null;
  registrationUsername?: string | null; // Registration trunk username (e.g. 8092); used as calling number toward the gateway
  registrationEndpointId?: string | null;
  b2buaGatewayIp?: string | null;
  b2buaGatewayTransport?: string | null;
  aLegEncrypted?: boolean; // Whether the inbound A-leg media is encrypted (SRTP); drives B-leg transfer trunk media policy
  forceBridged?: boolean;
  // Inbound SIP INVITE X- headers, surfaced as metadata.aplisay.sipHeaders. See CallScenario.sipHeaders.
  sipHeaders?: Record<string, string>;
}

export interface RunAgentWorkerParams<TContext = any, TRoom = any> {
  ctx: TContext;
  room: TRoom;
  agent: Agent;
  participant: ParticipantInfo | null;
  callerId: string;
  calledId: string;
  modelName: string;
  metadata: any;
  sendMessage: (message: any, createdAt?: Date) => Promise<void>;
  call: Call;
  onHangup: () => Promise<HangupResult>;
  onTransfer: (params: { args: any; participant: ParticipantInfo }) => Promise<any>;
  /**
   * Hands the worker's hangup latch a way to drive teardown directly, so an
   * agent-initiated hangup no longer depends solely on an AgentStateChanged
   * edge that may never arrive. Optional: transfer-only runs have no LLM and
   * therefore no hangup tool.
   */
  registerHangupExecutor?: (execute: HangupExecutor | null) => void;
  sessionRef: (session: voice.AgentSession | null) => voice.AgentSession | null;
  modelRef: (model: voice.Agent | null) => voice.Agent | null;
  getBridgedParticipant: () => SipParticipant | null;
  setBridgedParticipant: (p: SipParticipant | null) => void;
  checkForHangup: () => boolean;
  getConsultInProgress: () => boolean;
  getActiveCall: () => Call;
  /**
   * The agent session's own call, WITHOUT the blind-bridge override that
   * getActiveCall applies. Usage attribution (token/stt/tts component meters
   * produced by the agent session) must target this — never the no-agent
   * bridged tail leg that getActiveCall flips to after a transfer. Falls back
   * to getActiveCall when unset.
   */
  getAgentCall?: () => Call;
  /**
   * Repoints transcript logging and teardown at the continuation call created
   * by a full agent-stack handover (transfer_agent with a model change).
   */
  setActiveAgentCall?: (call: Call) => void;
  /**
   * Start/stop the comfort tone (options.transferTone) over the dead-air gap of
   * a full-stack agent-to-agent handover. No-ops when the option is unset.
   */
  startHandoverTone?: () => void;
  stopHandoverTone?: () => void;
  recordingOptions?: {
    enabled: boolean;
    key?: string;
  };
  /**
   * If true, skip agent setup and go straight to transfer mode.
   * Used for fallback transfers where the agent failed to start.
   */
  transferOnly?: boolean;
  /**
   * Transfer arguments to use when transferOnly is true.
   */
  transferArgs?: TransferArgs;
}

export interface TransferArgs {
  number: string;
  callerId?: string;
  operation?: 'blind' | 'consultative';
  transferPrompt?: string;
  consultFeedback?: boolean;
  forceBridged?: boolean;
  [key: string]: any;
  session?: voice.AgentSession;
}

export interface MessageData {
  [key: string]: any;
}

export interface FunctionContext {
  [functionName: string]: {
    description: string;
    parameters: {
      type: string;
      properties: Record<string, any>;
      required: string[];
    };
    execute: (args: any) => Promise<string>;
    type: string;
    [key: symbol]: any;
  };
}

export interface FunctionResult {
  function_results: Array<{
    result: any;
    error?: string;
  }>;
}
