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
  }>;
}
