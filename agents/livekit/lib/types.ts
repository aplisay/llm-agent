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
  // Present only on the registration-client path; absent on the SBC path.
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
  registrationEndpointId?: string | null;
  b2buaGatewayIp?: string | null;
  b2buaGatewayTransport?: string | null;
  forceBridged?: boolean;
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
  registrationOriginated?: boolean;
  trunkInfo?: TrunkInfo | null;
  registrationRegistrar?: string | null;
  registrationTransport?: string | null;
  registrationEndpointId?: string | null;
  b2buaGatewayIp?: string | null;
  b2buaGatewayTransport?: string | null;
  forceBridged?: boolean;
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
  onHangup: () => Promise<void>;
  onTransfer: (params: { args: any; participant: ParticipantInfo }) => Promise<any>;
  sessionRef: (session: voice.AgentSession | null) => voice.AgentSession | null;
  modelRef: (model: voice.Agent | null) => voice.Agent | null;
  getBridgedParticipant: () => SipParticipant | null;
  setBridgedParticipant: (p: SipParticipant | null) => void;
  checkForHangup: () => boolean;
  getConsultInProgress: () => boolean;
  getActiveCall: () => Call;
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
  // Force the final hop to be completed by bridging (legacy; inverse of forceRefer).
  forceBridged?: boolean;
  // Force the final hop to be completed via SIP REFER (with ?Replaces for the
  // consultative finalize) regardless of the origin default. Takes precedence
  // over forceBridged when both are set.
  forceRefer?: boolean;
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
