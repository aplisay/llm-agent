// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Ultravox API constants
export const SAMPLE_RATE = 48000;
export const NUM_CHANNELS = 1;
export const IN_FRAME_SIZE = 2400; // 10ms at 48kHz
export const OUT_FRAME_SIZE = 1200; // 10ms at 48kHz

// Ultravox API types
export type Voice = string;
export type AudioFormat = 'pcm16';
export type Model = string;

export interface UltravoxTool {
  nameOverride: string;
  temporaryTool: {
    description: string;
    timeout: string;
    http?: {
      baseUrlPattern: string;
      httpMethod: string;
    };
    client?: Record<string, unknown>;
    dynamicParameters?: Array<{
      name: string;
      location: string;
      schema: {
        type: string;
        description: string;
      };
      required: boolean;
    }>;
    staticParameters?: Array<{
      name: string;
      location: string;
      value: string;
    }>;
    requirements?: {
      httpSecurityOptions: {
        options: Array<{
          requirements: Record<string, unknown>;
        }>;
      };
    };
  };
  authTokens?: Record<string, string>;
}

export interface UltravoxModelData {
  model: string;
  maxDuration: string;
  timeExceededMessage: string;
  systemPrompt: string;
  selectedTools: UltravoxTool[];
  temperature?: number;
  voice?: string;
  transcriptOptional: boolean;
  medium?: {
    serverWebSocket: {
      inputSampleRate: number;
      outputSampleRate: number;
      clientBufferSizeMs: number;
    };
  };
  firstSpeaker?: string;
}

// Ultravox WebSocket message types
export type UltravoxMessageType =
  | 'state'
  | 'transcript'
  | 'experimental_message'
  | 'audio'
  | 'client_tool_invocation'
  | 'client_tool_result';

export interface UltravoxStatusMessage {
  type: 'state';
  state: string;
}

export interface UltravoxTranscriptMessage {
  type: 'transcript';
  role: string;
  text?: string;
  medium: 'voice' | 'text';
  delta?: string;
  final: boolean;
  ordinal?: number;
}

export interface UltravoxExperimentalMessage {
  type: 'experimental_message';
  message: {
    type: string;
    message: string;
  };
}

export interface UltravoxAudioMessage {
  type: 'audio';
  audio: string; // base64 encoded audio data
}

export interface UltravoxFunctionCallMessage {
  type: 'client_tool_invocation';
  toolName: string;
  parameters: string;
  invocationId: string;
}

export interface UltravoxFunctionResultMessage {
  type: 'client_tool_result';
  invocationId: string;
  agentReaction?: 'speaks' | 'listens' | 'speaks-once';
  result?: string;
  responseType?: 'tool-reponse' | 'tool-error';
  errorType?: 'implementation-error' | undefined;
  errorMessage?: string;
}

export type UltravoxMessage =
  | UltravoxStatusMessage
  | UltravoxTranscriptMessage
  | UltravoxExperimentalMessage
  | UltravoxAudioMessage
  | UltravoxFunctionCallMessage
  | UltravoxFunctionResultMessage;

// Ultravox API response types
export interface UltravoxCallResponse {
  callId: string;
  ended: boolean;
  joinUrl: string;
}

export interface UltravoxVoice {
  name: string;
  description: string;
}

export interface UltravoxVoicesResponse {
  results: UltravoxVoice[];
}

// --- OpenAI protocol types for event compatibility ---

export type Realtime_AudioFormat = 'pcm16';
export type Realtime_Role = 'system' | 'assistant' | 'user' | 'tool';
export type Realtime_GenerationFinishedReason =
  | 'stop'
  | 'max_tokens'
  | 'content_filter'
  | 'interrupt';
export type Realtime_InputTranscriptionModel = 'whisper-1' | string;
export type Realtime_Modality = 'text' | 'audio';
export type Realtime_ToolChoice = 'auto' | 'none' | 'required' | string;
export type Realtime_State = 'initializing' | 'listening' | 'thinking' | 'speaking' | string;
export type Realtime_ResponseStatus =
  | 'in_progress'
  | 'completed'
  | 'incomplete'
  | 'cancelled'
  | 'failed'
  | string;
export type Realtime_ClientEventType =
  | 'session.update'
  | 'input_audio_buffer.append'
  | 'input_audio_buffer.commit'
  | 'input_audio_buffer.clear'
  | 'conversation.item.create'
  | 'conversation.item.truncate'
  | 'conversation.item.delete'
  | 'response.create'
  | 'response.cancel';
export type Realtime_ServerEventType =
  | 'error'
  | 'session.created'
  | 'session.updated'
  | 'conversation.created'
  | 'input_audio_buffer.committed'
  | 'input_audio_buffer.cleared'
  | 'input_audio_buffer.speech_started'
  | 'input_audio_buffer.speech_stopped'
  | 'conversation.item.created'
  | 'conversation.item.input_audio_transcription.completed'
  | 'conversation.item.input_audio_transcription.failed'
  | 'conversation.item.truncated'
  | 'conversation.item.deleted'
  | 'response.created'
  | 'response.done'
  | 'response.output_item.added'
  | 'response.output_item.done'
  | 'response.content_part.added'
  | 'response.content_part.done'
  | 'response.text.delta'
  | 'response.text.done'
  | 'response.audio_transcript.delta'
  | 'response.audio_transcript.done'
  | 'response.audio.delta'
  | 'response.audio.done'
  | 'response.function_call_arguments.delta'
  | 'response.function_call_arguments.done'
  | 'rate_limits.updated';

export type Realtime_AudioBase64Bytes = string;

export interface Realtime_Tool {
  type: 'function';
  name: string;
  description?: string;
  parameters: {
    type: 'object';
    properties: {
      [prop: string]: {
        [prop: string]: any;
      };
    };
    required: string[];
  };
}

export type Realtime_TurnDetectionType = {
  type: 'server_vad';
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
};

export type Realtime_InputAudioTranscription = {
  model: Realtime_InputTranscriptionModel;
};

export interface Realtime_InputTextContent {
  type: 'input_text';
  text: string;
}

export interface Realtime_InputAudioContent {
  type: 'input_audio';
  audio: Realtime_AudioBase64Bytes;
}

export interface Realtime_TextContent {
  type: 'text';
  text: string;
}

export interface Realtime_AudioContent {
  type: 'audio';
  audio: Realtime_AudioBase64Bytes;
  transcript: string;
}

export type Realtime_Content =
  | Realtime_InputTextContent
  | Realtime_InputAudioContent
  | Realtime_TextContent
  | Realtime_AudioContent;
export type Realtime_ContentPart = {
  type: 'text' | 'audio';
  audio?: Realtime_AudioBase64Bytes;
  transcript?: string;
};

export interface Realtime_BaseItem {
  id: string;
  object: 'realtime.item';
  type: string;
}

export interface Realtime_SystemItem extends Realtime_BaseItem {
  type: 'message';
  role: 'system';
  content: Realtime_InputTextContent;
}

export interface Realtime_UserItem extends Realtime_BaseItem {
  type: 'message';
  role: 'user';
  content: (Realtime_InputTextContent | Realtime_InputAudioContent)[];
}

export interface Realtime_AssistantItem extends Realtime_BaseItem {
  type: 'message';
  role: 'assistant';
  content: (Realtime_TextContent | Realtime_AudioContent)[];
}

export interface Realtime_FunctionCallItem extends Realtime_BaseItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface Realtime_FunctionCallOutputItem extends Realtime_BaseItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type Realtime_ItemResource =
  | Realtime_SystemItem
  | Realtime_UserItem
  | Realtime_AssistantItem
  | Realtime_FunctionCallItem
  | Realtime_FunctionCallOutputItem;

export interface Realtime_SessionResource {
  id: string;
  object: 'realtime.session';
  model: string;
  modalities: ['text', 'audio'] | ['text'];
  instructions: string;
  voice: Voice;
  input_audio_format: Realtime_AudioFormat;
  output_audio_format: Realtime_AudioFormat;
  input_audio_transcription: Realtime_InputAudioTranscription | null;
  turn_detection: Realtime_TurnDetectionType | null;
  tools: Realtime_Tool[];
  tool_choice: Realtime_ToolChoice;
  temperature: number;
  max_response_output_tokens: number | 'inf';
  expires_at: number;
}

export interface Realtime_ConversationResource {
  id: string;
  object: 'realtime.conversation';
}

export type Realtime_ResponseStatusDetails =
  | {
      type: 'incomplete';
      reason: 'max_output_tokens' | 'content_filter' | string;
    }
  | {
      type: 'failed';
      error?: {
        code: 'server_error' | 'rate_limit_exceeded' | string;
        message: string;
      };
    }
  | {
      type: 'cancelled';
      reason: 'turn_detected' | 'client_cancelled' | string;
    };

export interface Realtime_ModelUsage {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  input_token_details: {
    text_tokens: number;
    audio_tokens: number;
    cached_tokens: number;
    cached_tokens_details: {
      text_tokens: number;
      audio_tokens: number;
    };
  };
  output_token_details: {
    text_tokens: number;
    audio_tokens: number;
  };
}

export interface Realtime_ResponseResource {
  id: string;
  object: 'realtime.response';
  status: Realtime_ResponseStatus;
  status_details?: Realtime_ResponseStatusDetails;
  output: Realtime_ItemResource[];
  usage?: Realtime_ModelUsage;
}

// --- OpenAI event interfaces for compatibility ---

export interface Realtime_BaseClientEvent {
  event_id?: string;
  type: Realtime_ClientEventType;
}

export interface Realtime_SessionUpdateEvent extends Realtime_BaseClientEvent {
  type: 'session.update';
  session: Partial<{
    modalities: ['text', 'audio'] | ['text'];
    instructions: string;
    voice: Voice;
    input_audio_format: Realtime_AudioFormat;
    output_audio_format: Realtime_AudioFormat;
    input_audio_transcription: Realtime_InputAudioTranscription | null;
    turn_detection: Realtime_TurnDetectionType | null;
    tools: Realtime_Tool[];
    tool_choice: Realtime_ToolChoice;
    temperature: number;
    max_response_output_tokens?: number | 'inf';
  }>;
}

export interface Realtime_InputAudioBufferAppendEvent extends Realtime_BaseClientEvent {
  type: 'input_audio_buffer.append';
  audio: Realtime_AudioBase64Bytes;
}

export interface Realtime_InputAudioBufferCommitEvent extends Realtime_BaseClientEvent {
  type: 'input_audio_buffer.commit';
}

export interface Realtime_InputAudioBufferClearEvent extends Realtime_BaseClientEvent {
  type: 'input_audio_buffer.clear';
}

export interface Realtime_UserItemCreate {
  type: 'message';
  role: 'user';
  content: (Realtime_InputTextContent | Realtime_InputAudioContent)[];
}

export interface Realtime_AssistantItemCreate {
  type: 'message';
  role: 'assistant';
  content: Realtime_TextContent[];
}

export interface Realtime_SystemItemCreate {
  type: 'message';
  role: 'system';
  content: Realtime_InputTextContent[];
}

export interface Realtime_FunctionCallOutputItemCreate {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type Realtime_ConversationItemCreateContent =
  | Realtime_UserItemCreate
  | Realtime_AssistantItemCreate
  | Realtime_SystemItemCreate
  | Realtime_FunctionCallOutputItemCreate;

export interface Realtime_ConversationItemCreateEvent extends Realtime_BaseClientEvent {
  type: 'conversation.item.create';
  previous_item_id?: string;
  item: Realtime_ConversationItemCreateContent;
}

export interface Realtime_ConversationItemTruncateEvent extends Realtime_BaseClientEvent {
  type: 'conversation.item.truncate';
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

export interface Realtime_ConversationItemDeleteEvent extends Realtime_BaseClientEvent {
  type: 'conversation.item.delete';
  item_id: string;
}

export interface Realtime_ResponseCreateEvent extends Realtime_BaseClientEvent {
  type: 'response.create';
  response?: Partial<{
    modalities: ['text', 'audio'] | ['text'];
    instructions: string;
    voice: Voice;
    output_audio_format: Realtime_AudioFormat;
    tools?: Realtime_Tool[];
    tool_choice: Realtime_ToolChoice;
    temperature: number;
    max_output_tokens: number | 'inf';
  }>;
}

export interface Realtime_ResponseCancelEvent extends Realtime_BaseClientEvent {
  type: 'response.cancel';
}

export type Realtime_ClientEvent =
  | Realtime_SessionUpdateEvent
  | Realtime_InputAudioBufferAppendEvent
  | Realtime_InputAudioBufferCommitEvent
  | Realtime_InputAudioBufferClearEvent
  | Realtime_ConversationItemCreateEvent
  | Realtime_ConversationItemTruncateEvent
  | Realtime_ConversationItemDeleteEvent
  | Realtime_ResponseCreateEvent
  | Realtime_ResponseCancelEvent;

export interface Realtime_BaseServerEvent {
  event_id: string;
  type: Realtime_ServerEventType;
}

export interface Realtime_ErrorEvent extends Realtime_BaseServerEvent {
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'server_error' | string;
    code?: string;
    message: string;
    param: string;
    event_id: string;
  };
}

export interface Realtime_SessionCreatedEvent extends Realtime_BaseServerEvent {
  type: 'session.created';
  session: Realtime_SessionResource;
}

export interface Realtime_SessionUpdatedEvent extends Realtime_BaseServerEvent {
  type: 'session.updated';
  session: Realtime_SessionResource;
}

export interface Realtime_ConversationCreatedEvent extends Realtime_BaseServerEvent {
  type: 'conversation.created';
  conversation: Realtime_ConversationResource;
}

export interface Realtime_InputAudioBufferCommittedEvent extends Realtime_BaseServerEvent {
  type: 'input_audio_buffer.committed';
  item_id: string;
}

export interface Realtime_InputAudioBufferClearedEvent extends Realtime_BaseServerEvent {
  type: 'input_audio_buffer.cleared';
}

export interface Realtime_InputAudioBufferSpeechStartedEvent extends Realtime_BaseServerEvent {
  type: 'input_audio_buffer.speech_started';
  audio_start_ms: number;
  item_id: string;
}

export interface Realtime_InputAudioBufferSpeechStoppedEvent extends Realtime_BaseServerEvent {
  type: 'input_audio_buffer.speech_stopped';
  audio_end_ms: number;
  item_id: string;
}

export interface Realtime_ConversationItemCreatedEvent extends Realtime_BaseServerEvent {
  type: 'conversation.item.created';
  item: Realtime_ItemResource;
}

export interface Realtime_ConversationItemInputAudioTranscriptionCompletedEvent
  extends Realtime_BaseServerEvent {
  type: 'conversation.item.input_audio_transcription.completed';
  item_id: string;
  content_index: number;
  transcript: string;
}

export interface Realtime_ConversationItemInputAudioTranscriptionFailedEvent
  extends Realtime_BaseServerEvent {
  type: 'conversation.item.input_audio_transcription.failed';
  item_id: string;
  content_index: number;
  error: {
    type: string;
    code?: string;
    message: string;
    param: null;
  };
}

export interface Realtime_ConversationItemTruncatedEvent extends Realtime_BaseServerEvent {
  type: 'conversation.item.truncated';
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

export interface Realtime_ConversationItemDeletedEvent extends Realtime_BaseServerEvent {
  type: 'conversation.item.deleted';
  item_id: string;
}

export interface Realtime_ResponseCreatedEvent extends Realtime_BaseServerEvent {
  type: 'response.created';
  response: Realtime_ResponseResource;
}

export interface Realtime_ResponseDoneEvent extends Realtime_BaseServerEvent {
  type: 'response.done';
  response: Realtime_ResponseResource;
}

export interface Realtime_ResponseOutputItemAddedEvent extends Realtime_BaseServerEvent {
  type: 'response.output_item.added';
  response_id: string;
  output_index: number;
  item: Realtime_ItemResource;
}

export interface Realtime_ResponseOutputItemDoneEvent extends Realtime_BaseServerEvent {
  type: 'response.output_item.done';
  response_id: string;
  output_index: number;
  item: Realtime_ItemResource;
}

export interface Realtime_ResponseContentPartAddedEvent extends Realtime_BaseServerEvent {
  type: 'response.content_part.added';
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  part: Realtime_ContentPart;
}

export interface Realtime_ResponseContentPartDoneEvent extends Realtime_BaseServerEvent {
  type: 'response.content_part.done';
  response_id: string;
  output_index: number;
  content_index: number;
  part: Realtime_ContentPart;
}

export interface Realtime_ResponseTextDeltaEvent extends Realtime_BaseServerEvent {
  type: 'response.text.delta';
  response_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface Realtime_ResponseTextDoneEvent extends Realtime_BaseServerEvent {
  type: 'response.text.done';
  response_id: string;
  output_index: number;
  content_index: number;
  text: string;
}

export interface Realtime_ResponseAudioTranscriptDeltaEvent extends Realtime_BaseServerEvent {
  type: 'response.audio_transcript.delta';
  response_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface Realtime_ResponseAudioTranscriptDoneEvent extends Realtime_BaseServerEvent {
  type: 'response.audio_transcript.done';
  response_id: string;
  output_index: number;
  content_index: number;
  transcript: string;
}

export interface Realtime_ResponseAudioDeltaEvent extends Realtime_BaseServerEvent {
  type: 'response.audio.delta';
  response_id: string;
  output_index: number;
  content_index: number;
  delta: Realtime_AudioBase64Bytes;
}

export interface Realtime_ResponseAudioDoneEvent extends Realtime_BaseServerEvent {
  type: 'response.audio.done';
  response_id: string;
  output_index: number;
  content_index: number;
}

export interface Realtime_ResponseFunctionCallArgumentsDeltaEvent extends Realtime_BaseServerEvent {
  type: 'response.function_call_arguments.delta';
  response_id: string;
  output_index: number;
  delta: string;
}

export interface Realtime_ResponseFunctionCallArgumentsDoneEvent extends Realtime_BaseServerEvent {
  type: 'response.function_call_arguments.done';
  response_id: string;
  output_index: number;
  arguments: string;
}

export interface Realtime_RateLimitsUpdatedEvent extends Realtime_BaseServerEvent {
  type: 'rate_limits.updated';
  rate_limits: {
    name: 'requests' | 'tokens' | 'input_tokens' | 'output_tokens' | string;
    limit: number;
    remaining: number;
    reset_seconds: number;
  }[];
}

export type Realtime_ServerEvent =
  | Realtime_ErrorEvent
  | Realtime_SessionCreatedEvent
  | Realtime_SessionUpdatedEvent
  | Realtime_ConversationCreatedEvent
  | Realtime_InputAudioBufferCommittedEvent
  | Realtime_InputAudioBufferClearedEvent
  | Realtime_InputAudioBufferSpeechStartedEvent
  | Realtime_InputAudioBufferSpeechStoppedEvent
  | Realtime_ConversationItemCreatedEvent
  | Realtime_ConversationItemInputAudioTranscriptionCompletedEvent
  | Realtime_ConversationItemInputAudioTranscriptionFailedEvent
  | Realtime_ConversationItemTruncatedEvent
  | Realtime_ConversationItemDeletedEvent
  | Realtime_ResponseCreatedEvent
  | Realtime_ResponseDoneEvent
  | Realtime_ResponseOutputItemAddedEvent
  | Realtime_ResponseOutputItemDoneEvent
  | Realtime_ResponseContentPartAddedEvent
  | Realtime_ResponseContentPartDoneEvent
  | Realtime_ResponseTextDeltaEvent
  | Realtime_ResponseTextDoneEvent
  | Realtime_ResponseAudioTranscriptDeltaEvent
  | Realtime_ResponseAudioTranscriptDoneEvent
  | Realtime_ResponseAudioDeltaEvent
  | Realtime_ResponseAudioDoneEvent
  | Realtime_ResponseFunctionCallArgumentsDeltaEvent
  | Realtime_ResponseFunctionCallArgumentsDoneEvent
  | Realtime_RateLimitsUpdatedEvent;
