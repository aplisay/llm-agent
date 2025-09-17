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
import { voice } from "@livekit/agents";



export interface CallScenario {
  instance: Instance;
  agent: Agent | null;
  participant: ParticipantInfo | null;
  callerId: string;
  calledId: string;
  aplisayId: string;
  callId: string;
  callMetadata: CallMetadata;
  outboundCall: boolean;
  outboundInfo: OutboundInfo | null;
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
  // Back-compat with older call sites
  createModelRef?: (create: () => any) => any;
  sessionRef: (session: voice.AgentSession | null) => voice.AgentSession | null;
  setBridgedParticipant: (participant: any) => void;
  requestHangup: () => void;
  // consult transfer state management
  setConsultInProgress: (value: boolean) => void;
  setDeafenedTrackSids: (sids: string[]) => void;
  getConsultInProgress: () => boolean;
  getDeafenedTrackSids: () => string[];
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
  sendMessage: (message: any) => Promise<void>;
  call: Call;
  onHangup: () => Promise<void>;
  onTransfer: (params: { args: any; participant: ParticipantInfo }) => Promise<any>;
  sessionRef: (session: voice.AgentSession | null) => voice.AgentSession | null;
  modelRef: (model: voice.Agent | null) => voice.Agent | null;
  getModel: () => any;
  getBridgedParticipant: () => any;
  checkForHangup: () => boolean;
  getConsultInProgress: () => boolean;
  getDeafenedTrackSids: () => string[];
}

export interface TransferArgs {
  number: string;
  callerId?: string;
  operation?: 'blind' | 'consult_start' | 'consult_finalise' | 'consult_reject';
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
