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
import { type RemoteParticipant } from "@livekit/rtc-node";



export interface CallScenario {
  instance: Instance;
  agent: Agent | null;
  participant: RemoteParticipant | null;
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
  createModelRef: (create: () => any) => any;
  setBridgedParticipant: (participant: any) => void;
  requestHangup: () => void;
}

export interface RunAgentWorkerParams<TContext = any, TRoom = any> {
  ctx: TContext;
  room: TRoom;
  agent: Agent;
  participant: RemoteParticipant | null;
  callerId: string;
  calledId: string;
  modelName: string;
  metadata: any;
  sendMessage: (message: any) => Promise<void>;
  call: Call;
  onHangup: () => Promise<void>;
  onTransfer: (params: { args: any; participant: RemoteParticipant }) => Promise<any>;
  getModel: () => any;
  getBridgedParticipant: () => any;
  wantHangup: () => boolean;
}

export interface TransferArgs {
  number: string;
  [key: string]: any;
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
