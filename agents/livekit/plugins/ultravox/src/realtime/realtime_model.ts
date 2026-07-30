// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AsyncIterableQueue,
  AudioByteStream,
  Future,
  Queue,
  llm,
  log,
  stream,
  shortuuid,
} from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { once } from "node:events";
import { WebSocket } from "ws";
// import type { GenerationCreatedEvent } from '@livekit/agents';
import * as api_proto from "./api_proto.js";
import { UltravoxClient } from "./ultravox_client.js";
import { Realtime_InputTextContent } from "./api_proto.js";

type Modality = "text" | "audio";

interface ModelOptions {
  modalities: Modality[];
  instructions: string;
  callId?: string;
  voice?: api_proto.Voice;
  inputAudioFormat: api_proto.AudioFormat;
  outputAudioFormat: api_proto.AudioFormat;
  temperature: number;
  maxResponseOutputTokens: number;
  model: api_proto.Model;
  apiKey: string;
  baseURL: string;
  maxDuration: string;
  timeExceededMessage: string;
  transcriptOptional: boolean;
  firstSpeaker: string;
  vendorSpecific?: {
    ultravox?: {
      experimentalSettings?: {
        transcriptionProvider?: string;
        [key: string]: any;
      };
      vadSettings?: api_proto.UltravoxVadSettings;
      firstSpeakerSettings?: api_proto.UltravoxFirstSpeakerSettings;
      inactivityMessages?: api_proto.UltravoxInactivityMessage[];
      [key: string]: any;
    };
    [key: string]: any;
  };
}

export interface RealtimeResponse {
  id: string;
  status: api_proto.Realtime_ResponseStatus;
  statusDetails: api_proto.Realtime_ResponseStatusDetails | null;
  usage: api_proto.Realtime_ModelUsage | null;
  output: RealtimeOutput[];
  doneFut: Future;
  createdTimestamp: number;
  firstTokenTimestamp?: number;
}

export interface RealtimeOutput {
  responseId: string;
  itemId: string;
  outputIndex: number;
  role: api_proto.Realtime_Role;
  type: "message" | "function_call";
  content: RealtimeContent[];
  doneFut: Future;
}

export interface RealtimeContent {
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  text: string;
  audio: AudioFrame[];
  textStream: AsyncIterableQueue<string>;
  audioStream: AsyncIterableQueue<AudioFrame>;
  toolCalls: RealtimeToolCall[];
  contentType: api_proto.Realtime_Modality;
}

export interface RealtimeToolCall {
  name: string;
  arguments: string;
  toolCallID: string;
}

interface MessageGeneration {
  messageId: string;
  textChannel: stream.StreamChannel<string>;
  audioChannel: stream.StreamChannel<AudioFrame>;
  audioTranscript: string;
  modalities: Future<("text" | "audio")[]>;
}

interface ResponseGeneration {
  responseId: string;
  inputId: string;
  messageChannel: stream.StreamChannel<llm.MessageGeneration>;
  functionChannel: stream.StreamChannel<llm.FunctionCall>;
  audioChannel: stream.StreamChannel<AudioFrame>;
  textChannel: stream.StreamChannel<string>;
  inputTranscription: string;
  outputText: string;
  messages: Map<string, MessageGeneration>;

  /** @internal */
  _doneFut: Future;
  /** @internal */
  _done: boolean;
  /** @internal */
  _createdTimestamp: number;
  /** @internal */
  _firstTokenTimestamp?: number;
  /** @internal */
  _messageWritten: boolean;
}

class CreateResponseHandle {
  instructions?: string;
  doneFut: Future<llm.GenerationCreatedEvent>;
  // TODO(shubhra): add timeout
  constructor({ instructions }: { instructions?: string }) {
    this.instructions = instructions;
    this.doneFut = new Future();
  }
}

export interface InputSpeechTranscriptionCompleted {
  itemId: string;
  transcript: string;
}

export interface InputSpeechTranscriptionFailed {
  itemId: string;
  message: string;
}

export interface InputSpeechStarted {
  itemId: string;
}

export interface InputSpeechCommitted {
  itemId: string;
}

interface ContentPtr {
  response_id: string;
  output_index: number;
  content_index: number;
}

class InputAudioBuffer {
  #session: RealtimeSession;

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  append(frame: AudioFrame) {
    // Use the improved pushAudio method for proper buffering
    this.#session.pushAudio(frame);
  }

  clear() {
    // Clear audio buffer using the session's clearAudio method
    this.#session.clearAudio();
  }

  commit() {
    // Commit audio buffer using the session's commitAudio method
    this.#session.commitAudio();
  }
}

class ConversationItem {
  #session: RealtimeSession;
  #logger = log();

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  truncate(itemId: string, contentIndex: number, audioEnd: number) {
    // Not supported in Ultravox
    this.#logger.debug(
      { itemId, contentIndex, audioEnd },
      "Truncate not supported in Ultravox"
    );
  }

  delete(itemId: string) {
    // Not supported in Ultravox
    this.#logger.debug({ itemId }, "Delete not supported in Ultravox");
  }

  create(message: llm.ChatMessage, previousItemId?: string): void {
    if (!message.content) {
      return;
    }

    // For Ultravox, we handle messages through the WebSocket
    // This method is mainly for compatibility
    this.#logger.debug("Conversation item created", {
      message,
      previousItemId,
    });
  }
}

class Conversation {
  #session: RealtimeSession;

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  get item(): ConversationItem {
    return new ConversationItem(this.#session);
  }
}

class Response {
  #session: RealtimeSession;

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  create() {
    // Not needed for Ultravox - responses are automatic
  }

  cancel() {
    // Not supported in Ultravox
  }
}

/**
 * Return `base` with `firstSpeakerSettings` REPLACED by `override`, or `base`
 * shallow-copied when there is no override.
 *
 * Replace, never merge: an agent carrying `options.greeting` arrives here with
 * `firstSpeakerSettings.agent.text` already set (see voice-session-factory), and the
 * Ultravox API expects exactly one of `user` / `agent` — a merge would leave both
 * populated. The `vendorSpecific` containers are rebuilt rather than mutated so the
 * model's defaults, shared with every other session it creates and with the caller's
 * own options object, are left untouched.
 */
export function withFirstSpeakerOverride(
  base: ModelOptions,
  override?: api_proto.UltravoxFirstSpeakerSettings
): ModelOptions {
  const opts: ModelOptions = { ...base };
  if (!override) {
    return opts;
  }
  opts.vendorSpecific = {
    ...opts.vendorSpecific,
    ultravox: {
      ...opts.vendorSpecific?.ultravox,
      firstSpeakerSettings: override,
    },
  };
  return opts;
}

/**
 * Fold one transcript frame into the turn accumulated so far.
 *
 * `text` is an authoritative snapshot of the whole turn when present; otherwise the
 * frame carries an incremental `delta`. Ultravox does not guarantee `text` on the
 * final frame of a turn — see `#handleAgentTranscript`, which has buffered deltas for
 * that reason since inception — so a consumer that reads only `text` silently drops
 * any turn delivered purely as deltas.
 */
export function foldTranscriptFrame(
  buffer: string,
  frame: { text?: string; delta?: string }
): string {
  if (frame.text) {
    return frame.text;
  }
  if (frame.delta) {
    return buffer + frame.delta;
  }
  return buffer;
}

export class RealtimeModel extends llm.RealtimeModel {
  sampleRate = api_proto.SAMPLE_RATE;
  numChannels = api_proto.NUM_CHANNELS;
  inFrameSize = api_proto.IN_FRAME_SIZE;
  outFrameSize = api_proto.OUT_FRAME_SIZE;
  get model(): api_proto.Model {
    return this.#defaultOpts.model;
  }

  #defaultOpts: ModelOptions;
  #sessions: RealtimeSession[] = [];
  /**
   * One-shot `firstSpeakerSettings` override for the NEXT session created from
   * this model. See `setNextSessionFirstSpeaker`.
   */
  #nextSessionFirstSpeaker?: api_proto.UltravoxFirstSpeakerSettings;
  /** See {@link setProviderEndedCallback}. */
  #providerEndedCallback?: (info: { code?: number; reason?: string }) => void;
  #client: UltravoxClient;
  constructor({
    modalities = ["text", "audio"],
    instructions = "",
    callId,
    voice,
    inputAudioFormat = "pcm16",
    outputAudioFormat = "pcm16",
    temperature = 0.8,
    maxResponseOutputTokens = Infinity,
    model = "fixie-ai/ultravox-70B",
    apiKey = process.env.ULTRAVOX_API_KEY || "",
    baseURL = "https://api.ultravox.ai/api/",
    maxDuration = "305s",
    timeExceededMessage = "It has been great chatting with you, but we have exceeded our time now.",
    transcriptOptional = false,
    firstSpeaker = "FIRST_SPEAKER_AGENT",
    vendorSpecific,
  }: {
    modalities?: ["text", "audio"] | ["text"];
    instructions?: string;
    callId?: string;
    voice?: api_proto.Voice;
    inputAudioFormat?: api_proto.AudioFormat;
    outputAudioFormat?: api_proto.AudioFormat;
    temperature?: number;
    maxResponseOutputTokens?: number;
    model?: api_proto.Model;
    apiKey?: string;
    baseURL?: string;
    maxDuration?: string;
    timeExceededMessage?: string;
    transcriptOptional?: boolean;
    firstSpeaker?: string;
    vendorSpecific?: {
      ultravox?: {
        experimentalSettings?: {
          transcriptionProvider?: string;
          [key: string]: any;
        };
        vadSettings?: api_proto.UltravoxVadSettings;
        firstSpeakerSettings?: api_proto.UltravoxFirstSpeakerSettings;
        inactivityMessages?: api_proto.UltravoxInactivityMessage[];
        [key: string]: any;
      };
      [key: string]: any;
    };
  }) {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: true,
      autoToolReplyGeneration: false,
      audioOutput: true,
    });
    if (apiKey === "") {
      throw new Error(
        "Ultravox API key is required, either using the argument or by setting the ULTRAVOX_API_KEY environmental variable"
      );
    }

    // Hack to catch all attempts to use a llama 70b model to force backward compatibility
    if (model.match(/ultravox-70b/i)) {
      model = "ultravox-v0.6";
    }

    this.#defaultOpts = {
      modalities,
      instructions,
      callId,
      voice,
      inputAudioFormat,
      outputAudioFormat,
      temperature,
      maxResponseOutputTokens,
      model,
      apiKey,
      baseURL,
      maxDuration,
      timeExceededMessage,
      transcriptOptional,
      firstSpeaker,
      vendorSpecific,
    };

    this.#client = new UltravoxClient(apiKey, baseURL);
  }

  get sessions(): RealtimeSession[] {
    return this.#sessions;
  }

  /**
   * Get the active (first) session if one exists, without creating a new one.
   * This is useful when you need to access the existing session that's already running.
   * @returns The active RealtimeSession, or undefined if no session exists yet
   */
  getActiveSession(): RealtimeSession | undefined {
    return this.#sessions.length > 0 ? this.#sessions[0] : undefined;
  }

  /**
   * Shape the opening turn of the NEXT session created from this model, and only
   * that one.
   *
   * Used by the consultative-transfer consult leg: it shares the primary call's
   * model instance but has the opposite conversational posture — it DIALS its peer,
   * so the peer answers and greets first. Without this the model's default
   * `FIRST_SPEAKER_AGENT` makes the TransferAgent open its own turn immediately and
   * talk over the target's greeting, which Ultravox then discards as barge-in.
   *
   * Consumed and cleared by the next `session()` call. Call
   * `clearNextSessionFirstSpeaker()` if the session is never started, so the
   * override cannot leak onto an unrelated session (e.g. an agent handover).
   */
  setNextSessionFirstSpeaker(
    firstSpeakerSettings: api_proto.UltravoxFirstSpeakerSettings
  ): void {
    this.#nextSessionFirstSpeaker = firstSpeakerSettings;
  }

  /** Discard a pending {@link setNextSessionFirstSpeaker} override. */
  clearNextSessionFirstSpeaker(): void {
    this.#nextSessionFirstSpeaker = undefined;
  }

  /**
   * Called when Ultravox ends a session we did not ask it to end — its own
   * `maxDuration`, an `inactivityMessages` `endBehavior` hangup, or a genuine outage.
   *
   * Exists because the SDK's `AgentSession.Error` event is lossy: `agent_activity`'s
   * `onError` forwards `createErrorEvent(ev.error, …)`, i.e. the INNER `Error`, so the
   * `RealtimeModelError` wrapper's `type` and `recoverable` never reach a listener.
   * A subscriber therefore cannot distinguish a terminal provider hangup from a
   * routine recoverable reconnect, and guessing in either direction is harmful —
   * treating reconnects as fatal hangs up live calls, treating hangups as transient
   * leaves the caller on a dead line until an unrelated long-stop fires.
   *
   * Fires for the PRIMARY session only (the first this model creates). A consult
   * TransferAgent session and post-handover sessions share the model instance but
   * their ending must never tear down the primary call.
   */
  setProviderEndedCallback(
    cb: (info: { code?: number; reason?: string }) => void
  ): void {
    this.#providerEndedCallback = cb;
  }

  /** @internal Invoked by a RealtimeSession whose socket closed provider-side. */
  _notifyProviderEnded(
    session: RealtimeSession,
    info: { code?: number; reason?: string }
  ): void {
    if (this.#sessions[0] !== session) {
      return;
    }
    this.#providerEndedCallback?.(info);
  }

  /** The override awaiting the next `session()`, if any. Diagnostics/tests. */
  get pendingFirstSpeakerOverride():
    | api_proto.UltravoxFirstSpeakerSettings
    | undefined {
    return this.#nextSessionFirstSpeaker;
  }

  session(): RealtimeSession {
    const firstSpeakerOverride = this.#nextSessionFirstSpeaker;
    this.#nextSessionFirstSpeaker = undefined;
    const opts: ModelOptions = withFirstSpeakerOverride(
      this.#defaultOpts,
      firstSpeakerOverride
    );
    if (firstSpeakerOverride) {
      // Resolved lazily: RealtimeModel may be constructed before initializeLogger().
      log().info(
        { firstSpeakerSettings: firstSpeakerOverride },
        "applying one-shot firstSpeakerSettings override to new session"
      );
    }

    const newSession = new RealtimeSession(this, opts, this.#client, {
      chatCtx: new llm.ChatContext(),
      fncCtx: undefined,
    });

    // Set initial instructions from constructor
    newSession.instructions = opts.instructions;

    this.#sessions.push(newSession);
    return newSession;
  }

  async close() {
    await Promise.allSettled(this.#sessions.map((session) => session.close()));
  }
}

export class RealtimeSession extends llm.RealtimeSession {
  #chatCtx: llm.ChatContext | undefined = undefined;
  #fncCtx: llm.ToolContext | undefined = undefined;
  // Use RemoteChatContext like OpenAI for proper item insertion
  private remoteChatCtx: llm.RemoteChatContext = new llm.RemoteChatContext();
  #opts: ModelOptions;
  #client: UltravoxClient;
  #pendingResponses: { [id: string]: RealtimeResponse } = {};
  #sessionId = "not-connected";
  #ws: WebSocket | null = null;
  #expiresAt: number | null = null;
  #logger = log();
  #task: Promise<void> | undefined;
  #closing = true;
  #sessionFailed = false;
  #callCorrelationId: string | null = null;
  #sendQueue = new Queue<any>();
  #sendTaskRunning = false;
  #instanceId: string; // Unique ID for this instance to help debug
  // Expose instanceId as a getter for debugging
  get instanceId(): string {
    return this.#instanceId;
  }
  #callId: string | null = null;
  #currentResponseId: string | null = null;
  #currentOutputIndex = 0;
  #currentContentIndex = 0;
  #audioStream?: AudioByteStream;
  #audioBuffer: Buffer[] = [];
  #toolChoice: llm.ToolChoice | null = "auto";
  #messageStreamController?: ReadableStreamDefaultController<any>;
  #functionStreamController?: ReadableStreamDefaultController<any>;
  // Audio buffering and processing
  #bstream = new AudioByteStream(
    api_proto.SAMPLE_RATE,
    api_proto.NUM_CHANNELS,
    api_proto.SAMPLE_RATE / 10
  );
  #pushedDurationMs: number = 0;
  // Response generation tracking
  private currentGeneration?: ResponseGeneration;
  private responseCreatedFutures: { [id: string]: CreateResponseHandle } = {};
  // Track if we've emitted input_speech_started for the current user turn
  private userSpeechStartedEmitted = false;
  // Instructions handling like OpenAI
  public instructions?: string;
  // Agent transcript buffer for accumulating deltas
  #agentTranscriptBuffer: string = "";
  // User transcript buffer for accumulating deltas. Ultravox does not guarantee a
  // `text` property on the final frame of a turn (see #handleAgentTranscript, which
  // has buffered deltas for that reason since inception); without the same buffer on
  // the user side a delta-only turn is dropped outright and never reaches the chat
  // context, so the turn is absent from the transcript AND from the agent's history.
  #userTranscriptBuffer: string = "";
  // Ordinal of the user turn #userTranscriptBuffer belongs to, so a turn abandoned
  // without a final frame (barge-in, interruption) cannot prefix the next one.
  #userTranscriptOrdinal: number | undefined = undefined;
  // Track last item ID for proper insertion order
  #lastItemId: string | undefined = undefined;
  // Track message IDs that have been sent to Ultravox (to avoid duplicates)
  #sentMessageIds: Set<string> = new Set();
  // Track message IDs that came from audio transcription (don't send as text)
  #audioMessageIds: Set<string> = new Set();
  constructor(
    realtimeModel: llm.RealtimeModel,
    opts: ModelOptions,
    client: UltravoxClient,
    { fncCtx, chatCtx }: { fncCtx?: llm.ToolContext; chatCtx?: llm.ChatContext }
  ) {
    super(realtimeModel);
    // Generate unique instance ID for debugging (after super call)
    this.#instanceId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    this.#opts = opts;
    this.#client = client;
    this.#fncCtx = fncCtx;
    this.#chatCtx = chatCtx;
    this.#callCorrelationId = opts.callId ?? null;

    // Start the session immediately if tools are available, otherwise wait for updateTools
    if (fncCtx && Object.keys(fncCtx).length > 0) {
      this.#task = this.#start();
    } else {
      this.#logger.debug(
        "No tools provided at session creation, waiting for updateTools"
      );
    }
  }

  get chatCtx(): llm.ChatContext {
    // Return the merged chat context that includes both remoteChatCtx and #chatCtx
    // This ensures function calls and other items are properly included
    const remoteCtx = this.remoteChatCtx.toChatCtx();
    const localCtx = this.#chatCtx;
    
    if (!localCtx || localCtx.items.length === 0) {
      return remoteCtx;
    }
    
    // Merge both contexts, preferring localCtx for items that exist in both
    const merged = remoteCtx.copy();
    for (const item of localCtx.items) {
      const existingIndex = merged.items.findIndex((i) => i.id === item.id);
      if (existingIndex >= 0) {
        merged.items[existingIndex] = item; // Use local version if it exists
      } else {
        merged.items.push(item); // Add if it doesn't exist
      }
    }
    return merged;
  }

  get fncCtx(): llm.ToolContext | undefined {
    return this.#fncCtx;
  }

  get tools(): llm.ToolContext {
    return this.#fncCtx || {};
  }

  async updateInstructions(instructions: string): Promise<void> {
    const eventId = shortuuid("instructions_update_");
    this.queueMsg({
      type: "session.update",
      session: {
        instructions: instructions,
      },
      event_id: eventId,
    });
    this.instructions = instructions;
  }

  async updateChatCtx(chatCtx: llm.ChatContext): Promise<void> {
    this.#logger.debug({ chatCtx }, "updateChatCtx");
    // Merge the new chat context with the existing one
    // This ensures function calls and their outputs are properly tracked
    const currentCtx = this.#chatCtx || this.chatCtx.copy();
    const mergedCtx = currentCtx.copy();
    
    // Add new items from the provided chat context
    // Use computeChatCtxDiff to only add items that don't already exist
    const diffOps = llm.computeChatCtxDiff(currentCtx, chatCtx);
    for (const [previousItemId, itemId] of diffOps.toCreate) {
      const item = chatCtx.getById(itemId);
      if (item) {
        mergedCtx.items.push(item);
        // Also add to remoteChatCtx for consistency
        this.remoteChatCtx.insert(previousItemId ?? undefined, item);
        // Update lastItemId for proper insertion order
        this.#lastItemId = itemId;

        // Handle new user messages (Ultravox text input)
        // Only send if it's NOT an audio transcription (audio messages are tracked in _audioMessageIds)
        if (
          item.type === "message" &&
          item.role === "user" &&
          item.id && !this.#sentMessageIds.has(item.id)
        ) {
          // Check if this is an audio message (already transcribed by Ultravox)
          if (!this.#audioMessageIds.has(item.id)) {
            if (item.textContent) {
              this.#logger.debug(
                { itemId: item.id, textContent: item.textContent },
                "Sending user message as interactive text to Ultravox"
              );
              // Send interactive text to Ultravox (triggers generation)
              // This is the flow for generate_reply(user_input=...) from the framework
              try {
                const message = llm.ChatMessage.create({
                  id: item.id,
                  role: "user",
                  content: [item.textContent],
                });
                await this.sendUserMessage(message);
                this.#sentMessageIds.add(item.id);
              } catch (error) {
                this.#logger.error(
                  { error, itemId: item.id },
                  "Failed to send user message to Ultravox"
                );
              }
            }
          } else {
            this.#logger.debug(
              { itemId: item.id, textContent: item.textContent },
              "Skipping user message (already in context from audio)"
            );
            this.#sentMessageIds.add(item.id);
          }
        }
      }
    }
    
    this.#chatCtx = mergedCtx;


    this.#logger.debug(
      { 
        currentItemsCount: currentCtx.items.length,
        newItemsCount: chatCtx.items.length,
        mergedItemsCount: mergedCtx.items.length,
        addedItems: diffOps.toCreate.length,
        addedItemIds: diffOps.toCreate.map(([, id]) => id)
      },
      "Updated chat context"
    );
  }

  async updateTools(tools: llm.ToolContext): Promise<void> {
    this.#fncCtx = tools;

    // If the session hasn't started yet, start it now that we have tools
    if (!this.#task && tools && Object.keys(tools).length > 0) {
      this.#logger.debug("Starting session now that tools are available");
      this.#task = this.#start();
    } else if (this.#callId) {
      this.#logger.warn(
        "Tools updated after session started - Ultravox doesn't support updating tools after call creation"
      );
      // Note: Ultravox doesn't support updating tools after call creation
      // This is a limitation compared to OpenAI's realtime API
    }
  }

  updateOptions(options: { toolChoice?: llm.ToolChoice | null }): void {
    if (options.toolChoice !== undefined) {
      this.#toolChoice = options.toolChoice;
    }
  }

  pushAudio(frame: AudioFrame): void {
    // Process audio through resampling and buffering
    for (const f of this.resampleAudio(frame)) {
      // Type assertion: AudioByteStream.write() accepts ArrayBuffer, but f.data.buffer
      // is ArrayBufferLike (includes SharedArrayBuffer). In practice, both work the same.
      for (const nf of this.#bstream.write(f.data.buffer as ArrayBuffer)) {
        // Send buffered audio frame to Ultravox WebSocket
        this.sendAudioFrame(nf);
        // Track duration for proper audio handling
        this.#pushedDurationMs += (nf.samplesPerChannel / nf.sampleRate) * 1000;
      }
    }
  }

  async generateReply(
    instructions?: string
  ): Promise<llm.GenerationCreatedEvent> {
    const handle = this.createResponse({ instructions, userInitiated: true });
    return handle.doneFut.await;
  }

  async commitAudio(): Promise<void> {
    // Commit audio if we have enough duration (similar to OpenAI's 100ms requirement)
    if (this.#pushedDurationMs > 50) {
      // Ultravox might need less than OpenAI's 100ms
      this.#logger.debug(
        { duration: this.#pushedDurationMs },
        "Committing audio to Ultravox"
      );
      // Reset duration counter after commit
      this.#pushedDurationMs = 0;
    }
  }

  async clearAudio(): Promise<void> {
    // Clear audio buffer and reset duration tracking
    this.#pushedDurationMs = 0;
    this.#logger.debug("Cleared audio buffer for Ultravox");
  }

  async interrupt(): Promise<void> {
    // Not supported by Ultravox
  }

  async truncate(_opts: {
    messageId: string;
    audioEndMs: number;
  }): Promise<void> {
    // Not supported by Ultravox
  }

  set fncCtx(ctx: llm.ToolContext | undefined) {
    this.#fncCtx = ctx;
  }

  get conversation(): Conversation {
    return new Conversation(this);
  }

  get inputAudioBuffer(): InputAudioBuffer {
    return new InputAudioBuffer(this);
  }

  get response(): Response {
    return new Response(this);
  }

  get expiration(): number {
    if (!this.#expiresAt) {
      throw new Error("session not started");
    }
    return this.#expiresAt * 1000;
  }

  queueMsg(command: any): void {
    // Intercept certain OpenAI-style client events to keep local state in sync
    try {
      this.#logger.debug({ command }, "queueMsg");
      if (
        command &&
        typeof command === "object" &&
        typeof command.type === "string"
      ) {
        switch (command.type) {
          case "session.update": {
            // Merge supported session fields into opts and emit a session.updated for compatibility
            const sessionUpdate = command.session || {};
            if (typeof sessionUpdate.instructions === "string") {
              this.instructions = sessionUpdate.instructions;
            }
            if (typeof sessionUpdate.voice === "string") {
              this.#opts.voice = sessionUpdate.voice;
            }
            if (typeof sessionUpdate.temperature === "number") {
              this.#opts.temperature = sessionUpdate.temperature;
            }
            if (sessionUpdate.max_response_output_tokens !== undefined) {
              // accept number | 'inf'
              this.#opts.maxResponseOutputTokens =
                sessionUpdate.max_response_output_tokens === "inf"
                  ? Infinity
                  : Number(sessionUpdate.max_response_output_tokens);
            }
            // emit synthetic session.updated event
            // Convert modalities array to tuple type
            const modalitiesTupleForUpdate: ["text", "audio"] | ["text"] =
              this.#opts.modalities.includes("audio")
                ? (["text", "audio"] as ["text", "audio"])
                : (["text"] as ["text"]);

            const event: api_proto.Realtime_SessionUpdatedEvent = {
              event_id: this.#generateEventId(),
              type: "session.updated",
              session: {
                id: this.#sessionId,
                object: "realtime.session",
                model: this.#opts.model,
                modalities: modalitiesTupleForUpdate,
                instructions: this.instructions || "",
                voice: this.#opts.voice || "alloy",
                input_audio_format: this.#opts.inputAudioFormat,
                output_audio_format: this.#opts.outputAudioFormat,
                input_audio_transcription: null,
                turn_detection: null,
                tools: [],
                tool_choice: "auto",
                temperature: this.#opts.temperature,
                max_response_output_tokens:
                  this.#opts.maxResponseOutputTokens === Infinity
                    ? "inf"
                    : this.#opts.maxResponseOutputTokens,
                expires_at: this.#expiresAt ?? Date.now() + 5 * 60 * 1000,
              },
            };
            this.emit("session_updated", event);
            return; // do not forward to Ultravox
          }
          case "conversation.item.create":
          case "conversation.item.truncate":
          case "conversation.item.delete":
          case "response.create":
          case "response.cancel":
            this.#logger.debug({ command }, "received command");
            // Ultravox transport does not consume these. Treat as no-ops for transport
            // but keep local compatibility by emitting minimal events when possible.
            // For now, swallow and do not forward.
            return;
          default:
            this.#logger.debug({ command }, "received unknown command");
            break;
        }
      }
    } catch (err) {
      this.#logger.warn({ err }, "error handling client event locally");
    }
  }

  async sendUserMessage(message: llm.ChatMessage): Promise<void> {
    // Log instance information to verify we're using the same instance as sendTask
    this.#logger.debug({ 
      instanceId: this.#instanceId,
      sendQueueInstanceId: this.#sendQueue.constructor.name,
      sendQueueItemsLength: this.#sendQueue.items.length,
      sendTaskRunning: this.#sendTaskRunning,
      ws: this.#ws,
      wsReadyState: this.#ws?.readyState,
      closing: this.#closing
    }, "sendUserMessage called");
    
    // Check if sendTask is running - if not, log a warning
    if (!this.#sendTaskRunning) {
      this.#logger.warn(
        { 
          instanceId: this.#instanceId,
          sendTaskRunning: this.#sendTaskRunning,
          ws: this.#ws,
          wsReadyState: this.#ws?.readyState,
          closing: this.#closing,
          queueLength: this.#sendQueue.items.length
        },
        "sendUserMessage called but sendTask is not running - message may not be sent"
      );
    }
    
    const userTextMessage = {
      type: "user_text_message",
      text: message.textContent as string,
      urgency: "soon",
    };
    this.#logger.debug({ message, userTextMessage, instanceId: this.#instanceId }, "queueinguser message to Ultravox");
    // Queue.put() is async but we don't need to await it - it will resolve after the item is added
    // However, we should handle any errors to prevent unhandled promise rejections
    await this.#sendQueue.put(userTextMessage).catch((error) => {
      this.#logger.error({ error, message: userTextMessage, instanceId: this.#instanceId }, "Failed to queue user message");
    });
    this.#logger.debug({ 
      message, 
      userTextMessage, 
      instanceId: this.#instanceId,
      sendQueueInstanceId: this.#sendQueue.constructor.name,
      queueLength: this.#sendQueue.items.length,
      sendTaskRunning: this.#sendTaskRunning
    }, "queued user message to Ultravox");
  }

  sendAudioFrame(frame: AudioFrame): void {
    // Don't send audio if session has failed
    if (this.#sessionFailed) {
      return;
    }

    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      try {
        // Convert audio frame to buffer more robustly
        const audioData = Buffer.from(
          frame.data.buffer,
          frame.data.byteOffset,
          frame.data.byteLength
        );

        /* Debug logging for audio format
        this.#logger.debug({
          sampleRate: frame.sampleRate,
          samplesPerChannel: frame.samplesPerChannel,
          channels: frame.channels,
          dataLength: audioData.length,
          expectedLength: frame.samplesPerChannel * frame.channels * 2 // s16le = 2 bytes per sample
        }, "Sending audio frame to Ultravox");
        */
        this.#ws.send(audioData);
      } catch (error) {
        this.#logger.error({ error }, "Failed to send audio frame to Ultravox");
      }
    } else {
      this.#logger.warn("WebSocket not ready, buffering audio frame");
      if (!this.#task) {
        this.#logger.debug(
          "No tools calls seem to have been pushed, but we are talking so starting the session anyway"
        );
        this.#task = this.#start();
      }

      // Buffer the frame for later sending when WebSocket is ready
      this.#audioBuffer.push(
        Buffer.from(
          frame.data.buffer,
          frame.data.byteOffset,
          frame.data.byteLength
        )
      );
    }
  }

  #getContent(
    ptr: ContentPtr = {
      response_id: this.#currentResponseId || "",
      output_index: this.#currentOutputIndex,
      content_index: this.#currentContentIndex,
    }
  ): {
    response?: RealtimeResponse;
    output?: RealtimeOutput;
    content?: RealtimeContent;
  } {
    const response = this.#pendingResponses[ptr.response_id];
    const output = response?.output?.[ptr.output_index];
    const content = output?.content?.[ptr.content_index];
    return { response, output, content };
  }

  #generateEventId(): string {
    return `ultravox-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private emitError({
    error,
    recoverable,
  }: {
    error: Error;
    recoverable: boolean;
  }): void {
    // Emit a standard RealtimeModelError so AgentSession can react generically.
    this.emit("error", {
      type: "realtime_model_error",
      timestamp: Date.now(),
      label: "ultravox-connection",
      error,
      recoverable,
    } as llm.RealtimeModelError);
  }

  #start(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        // Convert function context to Ultravox tools
        this.#logger.debug(
          { fncCtx: this.#fncCtx },
          "Converting function context to Ultravox tools"
        );
        const selectedTools: api_proto.UltravoxTool[] = [];
        if (this.#fncCtx) {
          this.#logger.debug(
            { fncCtxKeys: Object.keys(this.#fncCtx) },
            "Function context keys"
          );
          for (const [name, func] of Object.entries(this.#fncCtx)) {
            this.#logger.debug({ name, func }, "Processing function");
            const requiredList = Array.isArray(
              (func as any).parameters?.required
            )
              ? ((func as any).parameters.required as string[])
              : [];
            const properties = (func as any).parameters?.properties || {};
            const dynamicParams = Object.entries(properties).map(
              ([propName, prop]) => ({
                name: propName,
                location: "PARAMETER_LOCATION_BODY",
                schema: {
                  type: (prop as any).type || "string",
                  description: (prop as any).description || "",
                },
                required: requiredList.includes(propName),
              })
            );
            const tool: api_proto.UltravoxTool = {
              nameOverride: name,
              temporaryTool: {
                description: (func as any).description || "",
                timeout: "30s",
                client: {},
                dynamicParameters: dynamicParams,
                staticParameters: [],
              },
            };
            selectedTools.push(tool);
            this.#logger.debug({ tool }, "Created Ultravox tool");
          }
        }
        this.#logger.debug(
          { selectedToolsCount: selectedTools.length, selectedTools },
          "Selected tools for Ultravox"
        );

        // Create Ultravox call
        const uv = this.#opts.vendorSpecific?.ultravox;
        const modelData: api_proto.UltravoxModelData = {
          model: this.#opts.model,
          maxDuration: this.#opts.maxDuration,
          timeExceededMessage: this.#opts.timeExceededMessage,
          systemPrompt: this.instructions || this.#opts.instructions || "",
          selectedTools,
          temperature: this.#opts.temperature,
          voice: this.#opts.voice,
          transcriptOptional: this.#opts.transcriptOptional,
          medium: {
            serverWebSocket: {
              inputSampleRate: 24000,
              outputSampleRate: 24000,
              clientBufferSizeMs: 60,
              mediaIdleTimeout: "30s",
            },
          },
        };

        // Prefer firstSpeakerSettings (Ultravox-recommended) over deprecated firstSpeaker.
        if (uv?.firstSpeakerSettings != null) {
          modelData.firstSpeakerSettings = uv.firstSpeakerSettings;
        } else {
          modelData.firstSpeaker = this.#opts.firstSpeaker;
        }

        // Add vendor-specific options (e.g., experimentalSettings, vadSettings)
        if (uv?.experimentalSettings) {
          modelData.experimentalSettings = uv.experimentalSettings;
          this.#logger.debug(
            { experimentalSettings: modelData.experimentalSettings },
            "Added experimental settings from vendor-specific options"
          );
        }
        if (uv?.vadSettings != null) {
          modelData.vadSettings = uv.vadSettings;
          this.#logger.debug(
            { vadSettings: modelData.vadSettings },
            "Added VAD settings from vendor-specific options"
          );
        }
        if (Array.isArray(uv?.inactivityMessages)) {
          modelData.inactivityMessages = uv.inactivityMessages;
          this.#logger.debug(
            { count: modelData.inactivityMessages.length },
            "Added inactivityMessages from vendor-specific options"
          );
        }

        this.#logger.info(
          { callId: this.#callCorrelationId },
          "Creating Ultravox call"
        );
        const callResponse = await this.#client.createCall(modelData);
        if (
          callResponse.ended ||
          !callResponse.callId ||
          !callResponse.joinUrl
        ) {
          const error = new Error("Failed to create Ultravox call");
          this.#logger.error({ callResponse }, "Failed to create Ultravox call");
          this.#sessionFailed = true;
          this.emitError({ error, recoverable: false });
          reject(error);
          return;
        }
        this.#callId = callResponse.callId;
        this.#logger.info(
          {
            ultravoxCallId: this.#callId,
            callId: this.#callCorrelationId,
          },
          "Created Ultravox call"
        );



        // Connect to Ultravox WebSocket
        const joinUrl = new URL(callResponse.joinUrl);
        joinUrl.searchParams.append("experimentalMessages", "debug");

        this.#logger.info({ joinUrl, ultravoxCallId: this.#callId, callId: this.#callCorrelationId }, "Connecting to Ultravox WebSocket");
        this.#ws = new WebSocket(joinUrl.toString());
        this.#logger.info({ ultravoxCallId: this.#callId, callId: this.#callCorrelationId }, "WebSocket created");

        this.#ws.onerror = (error) => {
          const errorMsg = "Ultravox WebSocket error: " + error.message;
          // Mirror onclose's #closing guard. Without it a socket that errors during a
          // teardown WE initiated — agent handover closing the outgoing session, the
          // consult session closing after accept/reject, ordinary call cleanup — is
          // reported as an unrecoverable failure of a live session. That is a false
          // positive today (it only mislabels a log line) but becomes a call-killer
          // once the runtime acts on provider-ended, so guard it at the source.
          if (this.#closing) {
            this.#logger.info(
              { error, callId: this.#callId },
              "Ultravox WebSocket error during local close; ignoring"
            );
            return;
          }
          this.#logger.error({ error }, "Ultravox WebSocket error occurred");
          this.#sessionFailed = true;
          this.#notifyProviderEnded({ reason: error.message });
          this.emitError({ error: new Error(errorMsg), recoverable: false });
          reject(new Error(errorMsg));
        };

        await once(this.#ws, "open");
        this.#closing = false;
        this.#sessionId = this.#callId;
        this.#expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
        this.#logger.info({ ultravoxCallId: this.#callId, joinURL: joinUrl?.toString() },
          "Connected to Ultravox WebSocket"
        );

        // Flush any buffered audio frames now that WebSocket is ready
        this.#flushAudioBuffer();

        // Emit session created event (Livekit) format)
        // Convert modalities array to tuple type
        const modalitiesTuple: ["text", "audio"] | ["text"] =
          this.#opts.modalities.includes("audio")
            ? (["text", "audio"] as ["text", "audio"])
            : (["text"] as ["text"]);

        this.emit("session_created", {
          event_id: this.#generateEventId(),
          type: "session.created",
          session: {
            id: this.#sessionId,
            object: "realtime.session",
            model: this.#opts.model,
            modalities: modalitiesTuple,
            instructions: this.instructions || "",
            voice: this.#opts.voice || "alloy",
            input_audio_format: this.#opts.inputAudioFormat,
            output_audio_format: this.#opts.outputAudioFormat,
            input_audio_transcription: null,
            turn_detection: null,
            tools: [],
            tool_choice: "auto",
            temperature: this.#opts.temperature,
            max_response_output_tokens:
              this.#opts.maxResponseOutputTokens === Infinity
                ? "inf"
                : this.#opts.maxResponseOutputTokens,
            expires_at: this.#expiresAt,
          },
        } as api_proto.Realtime_SessionCreatedEvent);

        // Also emit a synthetic session.updated to align with newer interface expectations
        this.emit("session_updated", {
          event_id: this.#generateEventId(),
          type: "session.updated",
          session: {
            id: this.#sessionId,
            object: "realtime.session",
            model: this.#opts.model,
            modalities: modalitiesTuple,
            instructions: this.instructions || "",
            voice: this.#opts.voice || "alloy",
            input_audio_format: this.#opts.inputAudioFormat,
            output_audio_format: this.#opts.outputAudioFormat,
            input_audio_transcription: null,
            turn_detection: null,
            tools: [],
            tool_choice: "auto",
            temperature: this.#opts.temperature,
            max_response_output_tokens:
              this.#opts.maxResponseOutputTokens === Infinity
                ? "inf"
                : this.#opts.maxResponseOutputTokens,
            expires_at: this.#expiresAt!,
          },
        } as api_proto.Realtime_SessionUpdatedEvent);

        this.#ws.onmessage = (message) => {
          if (message.data instanceof Buffer) {
            this.#handleAudio(message.data);
          } else {
            const event: api_proto.UltravoxMessage = JSON.parse(
              message.data as string
            );

            this.#handleMessage(event);
          }
        };

        const sendTask = async () => {
          this.#sendTaskRunning = true;
          this.#logger.debug({ 
            instanceId: this.#instanceId,
            sendQueueInstanceId: this.#sendQueue.constructor.name,
            sendQueueItemsLength: this.#sendQueue.items.length
          }, "sendTask started");
          while (
            this.#ws &&
            !this.#closing &&
            this.#ws.readyState === WebSocket.OPEN
          ) {
            try {
              // Log queue state before waiting
              const queueLength = this.#sendQueue.items.length;
              this.#logger.debug({ 
                sendQueueLength: queueLength,
                wsReadyState: this.#ws?.readyState,
                closing: this.#closing
              }, "sendTask loop - waiting for item");
              
              // Check if we should exit before waiting on the queue
              // This prevents getting stuck in get() if WebSocket closes while waiting
              if (!this.#ws || this.#closing || this.#ws.readyState !== WebSocket.OPEN) {
                this.#logger.debug("sendTask: WebSocket closed before queue get(), exiting");
                break;
              }
              
              // If there are items in the queue, get() should return immediately
              // If queue is empty, get() will wait for 'put' event
              const event = await this.#sendQueue.get();
              
              // Check for close sentinel - this is put in the queue when WebSocket closes
              if (event && typeof event === 'object' && 'type' in event && event.type === '__CLOSE_SENTINEL__') {
                this.#logger.debug("sendTask: Received close sentinel, exiting");
                break;
              }
              
              // Check again after get() returns - conditions may have changed
              if (!this.#ws || this.#closing || this.#ws.readyState !== WebSocket.OPEN) {
                this.#logger.debug("sendTask: WebSocket closed during queue get(), exiting");
                break;
              }
              this.#logger.debug({ 
                event, 
                sendQueueLength: this.#sendQueue.items.length,
                eventType: event?.type
              }, "sendTask loop - deQueuing event");
              // Check WebSocket state again before sending, as it may have changed during await
              if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
                try {
                  this.#ws.send(JSON.stringify(event));
                } catch (sendError) {
                  this.#logger.error({ sendError, event }, "Error sending event to WebSocket");
                  // If send fails, the WebSocket is likely closed, so break the loop
                  break;
                }
              } else {
                this.#logger.warn("WebSocket closed while waiting for queue item");
                // Don't re-queue - if WebSocket is closed, we can't send it anyway
                break;
              }
            } catch (error) {
              this.#logger.error({ error }, "Error in sendTask loop");
              // Queue.get() shouldn't normally throw, but if it does, we should still try to continue
              // Only break if WebSocket is closed or we're closing
              if (!this.#ws || this.#closing || this.#ws.readyState !== WebSocket.OPEN) {
                break;
              }
              // Otherwise, continue the loop - the error might be transient
              // Add a small delay to prevent tight error loops
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
          this.#sendTaskRunning = false;
          this.#logger.debug({ ws: this.#ws, closing: this.#closing, readyState: this.#ws?.readyState }, "sendTask finished");
        };

        // Start sendTask and handle any unhandled rejections
        sendTask().catch((error) => {
          this.#logger.error({ error }, "Unhandled error in sendTask");
          this.emitError({ error, recoverable: true });
        });

        this.#ws.onclose = (event?: { code?: number; reason?: string }) => {
          // NB no #expiresAt short-circuit here. It used to set #closing = true once
          // Date.now() passed a HARDCODED start+5min (see #expiresAt assignment), which
          // silently swallowed every provider-side close after that point — no error,
          // no signal, and the SIP leg left up with a dead agent. Deriving it from
          // maxDuration would be worse still: it would suppress exactly the provider
          // hangups we now need to act on (Ultravox maxDuration, and the
          // inactivityMessages endBehavior hangup). #expiresAt remains for the session
          // -update payloads that report it; it is not a close classifier.
          const code = event?.code;
          const reason = event?.reason || undefined;
          if (!this.#closing) {
            const errorMsg = "Ultravox connection closed unexpectedly";
            this.#logger.error(
              { callId: this.#callId, code, reason },
              "Ultravox WebSocket closed unexpectedly"
            );
            this.#sessionFailed = true;
            // The provider ended this session and we did not ask it to. The SDK's
            // AgentSession.Error event cannot carry this: it forwards the INNER Error
            // (agent_activity onError -> createErrorEvent(ev.error, …)), so `type` and
            // `recoverable` are stripped and a listener cannot tell a terminal death
            // from a routine reconnect. Report it out-of-band instead, so the runtime
            // can end the call rather than leaving the caller on a dead line.
            this.#notifyProviderEnded({ code, reason });
            const error = new Error(errorMsg);
            this.emitError({ error, recoverable: false });
            reject(error);
          } else {
            this.#logger.info(
              { callId: this.#callId, code, reason },
              "Ultravox WebSocket closed (initiated locally)"
            );
          }
          this.#closing = true;
          this.#ws = null;
          // Wake up sendTask if it's waiting on the queue by putting a sentinel value
          // This ensures sendTask can exit its loop even if it's stuck in get()
          this.#sendQueue.put({ type: '__CLOSE_SENTINEL__' }).catch(() => {
            // Ignore errors - queue might be in a bad state, but we're closing anyway
          });
          !this.#closing && this.close();
          resolve();
        };
      } catch (error) {
        const err =
          error instanceof Error ? error : new Error(String(error));
        this.#logger.error({ error: err, message: err.message, stack: err.stack }, "Error in session open");
        this.#sessionFailed = true;
        this.emitError({ error: err, recoverable: false });
        reject(err);
      }
    });
  }

  async close() {
    this.#logger.info({ ws: this.#ws, call: this.#callId }, "closing call");
    if (!this.#ws) return;
    this.#closing = true;
    await this.#ws.close();
    this.#logger.debug({ callId: this.#callId }, "ws closed, deleting call");
    if (this.#callId) {
      try {
        await this.#client.deleteCall(this.#callId);
      } catch (error: any) {
        this.#logger.error({ error, message: error?.message, stack: error?.stack }, "Error deleting call");
      }
    }
    this.#logger.debug({ callId: this.#callId }, "call deleted");
    this.emit("close", { callId: this.#callId });
    this.#logger.debug({ callId: this.#callId }, "call close");
    await super.close();

    this.#logger.debug({ callId: this.#callId }, "call closed");
  }

  #handleMessage(event: api_proto.UltravoxMessage): void {
    //this.#logger.debug({ event }, "handleMessage");
    switch (event.type) {
      case "state":
        this.#handleStatus(event);
        break;
      case "transcript":
        this.#handleTranscript(event);
        break;
      case "client_tool_invocation":
        this.#handleFunctionCall(event);
        break;
      case "experimental_message":
        this.#handleExperimentalMessage(event);
        break;
      case "call_started":
        this.#logger.info({ event }, "Call started");
        break;
      default:
        this.#logger.debug({ event }, `Unknown message type: ${event.type}`);
    }
  }

  #handleStatus(event: api_proto.UltravoxStatusMessage): void {
    this.#logger.debug({ event }, "Status");

    // Map Ultravox status to OpenAI events
    if (event.state === "listening") {
      if (this.currentGeneration && !this.currentGeneration._done) {
        this.#markCurrentGenerationDone();
      }
    } else if (event.state === "thinking") {
    } else if (event.state === "speaking") {
      // If we have just moved into the speaking state, we need to create a new response
      // and create a new audio byte stream for the response. If we are already in the speaking state,
      // then nothing needs to be done.
        if(!this.currentGeneration || this.currentGeneration._done) {
          this.#startNewGeneration();
        }
    }
  }

  #startNewGeneration(): void {
    if (this.currentGeneration && !this.currentGeneration._done) {
      this.#logger.warn(
        "Starting new generation while another is active. Finalizing previous."
      );
      this.#markCurrentGenerationDone();
    }
    this.#audioStream = new AudioByteStream(
      api_proto.SAMPLE_RATE,
      api_proto.NUM_CHANNELS,
      api_proto.OUT_FRAME_SIZE
    );

    const responseId = this.#generateEventId();
    this.currentGeneration = {
      messageChannel: stream.createStreamChannel<llm.MessageGeneration>(),
      functionChannel: stream.createStreamChannel<llm.FunctionCall>(),
      responseId,
      inputId: this.#generateEventId(),
      textChannel: stream.createStreamChannel<string>(),
      audioChannel: stream.createStreamChannel<AudioFrame>(),
      inputTranscription: "",
      outputText: "",
      messages: new Map(),
      _doneFut: new Future(),
      _done: false,
      _createdTimestamp: Date.now(),
      _messageWritten: false,
    };

    // Write message to messageChannel immediately so AgentActivity can start reading
    // Include modalities so AgentActivity knows to use audioStream
    const modalitiesArray: ("text" | "audio")[] = this.#opts.modalities.includes("audio")
      ? ["text", "audio"]
      : ["text"];
    // Create modalities promise and verify it resolves correctly
    const modalitiesPromise = Promise.resolve(modalitiesArray);
    // Verify the promise resolves (for debugging)
    modalitiesPromise.then((mods) => {
      this.#logger.debug(
        { messageId: responseId, resolvedModalities: mods },
        "Modalities promise resolved"
      );
    }).catch((err) => {
      this.#logger.error(
        { messageId: responseId, error: err },
        "Modalities promise rejected"
      );
    });
    
    // Write message to messageChannel FIRST, matching Google's exact pattern
    // The message will be buffered in the stream until a reader consumes it
    // Include modalities as a Promise so AgentActivity knows to use audioStream
    const messageGeneration: llm.MessageGeneration & { modalities?: Promise<("text" | "audio")[]> } = {
      messageId: responseId,
      textStream: this.currentGeneration.textChannel.stream(),
      audioStream: this.currentGeneration.audioChannel.stream(),
      modalities: modalitiesPromise,
    };
    this.currentGeneration.messageChannel.write(messageGeneration);
    this.#logger.debug(
      { 
        messageId: responseId,
        modalities: modalitiesArray,
      },
      "Wrote message to messageChannel"
    );

    // Create generation event after writing message, matching Google's pattern
    // Check if there's a pending user-initiated generation (from generateReply)
    const pendingUserInitiatedKeys = Object.keys(this.responseCreatedFutures);
    const isUserInitiated = pendingUserInitiatedKeys.length > 0;
    
    const generationEvent: llm.GenerationCreatedEvent = {
      messageStream: this.currentGeneration.messageChannel.stream(),
      functionStream: this.currentGeneration.functionChannel.stream(),
      userInitiated: isUserInitiated,
    };

    // If this is a user-initiated generation, resolve the pending future
    if (isUserInitiated) {
      const eventId = pendingUserInitiatedKeys[0];
      const handle = this.responseCreatedFutures[eventId];
      if (handle && !handle.doneFut.done) {
        this.#logger.debug(
          { eventId, messageId: responseId },
          "Resolving pending user-initiated generation future"
        );
        handle.doneFut.resolve(generationEvent);
        delete this.responseCreatedFutures[eventId];
      }
    }

    // Emit generation_created - do NOT emit input_speech_started here
    // input_speech_started should only be emitted when the USER starts speaking (state -> listening)
    // Emitting it here would interrupt the speech handle created by generation_created
    this.#logger.debug(
      {
        messageId: responseId,
        hasMessageStream: !!generationEvent.messageStream,
        hasFunctionStream: !!generationEvent.functionStream,
        userInitiated: isUserInitiated,
      },
      "Emitting generation_created event - this should trigger speech handle creation and authorization"
    );
    this.emit("generation_created", generationEvent);
    this.#logger.debug(
      { 
        messageId: responseId,
        hasMessageStream: !!generationEvent.messageStream,
        hasFunctionStream: !!generationEvent.functionStream,
      },
      "generation_created event emitted - this should immediately trigger onGenerationCreated -> scheduleSpeech -> mainTask authorization"
    );
  }

  #markCurrentGenerationDone(): void {
    if (this.currentGeneration) {

      this.currentGeneration.audioChannel.close();
      this.currentGeneration.textChannel.close();
      this.currentGeneration.functionChannel.close();
      this.currentGeneration.messageChannel.close();
      this.currentGeneration._done = true;
      this.currentGeneration._doneFut.resolve();
      this.currentGeneration = undefined;

    }

  }

  /**
   * Tell the model this session was ended by the provider, so it can notify the
   * runtime (primary session only — see `RealtimeModel.setProviderEndedCallback`).
   * Best-effort: a failure here must never mask the error we are already reporting.
   */
  #notifyProviderEnded(info: { code?: number; reason?: string }): void {
    try {
      (this.realtimeModel as RealtimeModel)._notifyProviderEnded?.(this, info);
    } catch (e) {
      this.#logger.warn({ e }, "provider-ended notification failed");
    }
  }

  #handleTranscript(event: api_proto.UltravoxTranscriptMessage): void {
    event.final && this.#logger.debug(
      { event, ordinal: event.ordinal },
      "handleTranscript - received final transcript event"
    );

    if (event.role === "user") {
      // A new ordinal is a new turn: drop anything left over from a turn that was
      // abandoned without a final frame rather than prefixing it onto this one.
      if (
        event.ordinal !== undefined &&
        event.ordinal !== this.#userTranscriptOrdinal
      ) {
        this.#userTranscriptBuffer = "";
        this.#userTranscriptOrdinal = event.ordinal;
      }

      // Accumulate the turn the same way the agent side does: `text` is an
      // authoritative snapshot when present, otherwise fold in the delta. A final
      // frame carrying only `delta` used to fall through to "Skipping empty
      // transcript event" and the whole user turn was lost silently.
      this.#userTranscriptBuffer = foldTranscriptFrame(
        this.#userTranscriptBuffer,
        event
      );
      const transcript = this.#userTranscriptBuffer;

      // Emit input_speech_started when we first detect user speech (non-final transcript)
      // This interrupts any ongoing agent generation
      if (!this.userSpeechStartedEmitted && !event.final && transcript.trim().length > 0) {
        this.#logger.debug("Emitting input_speech_started on first user transcript");
        this.emit("input_speech_started", {
          itemId: "ultravox-user-input",
        } as InputSpeechStarted);
        this.userSpeechStartedEmitted = true;
      }

      // Only emit transcription events when there's actual text content
      if (transcript.trim().length > 0) {
        const transcriptionEvent = {
          itemId: shortuuid("user-transcript-"),
          transcript,
          isFinal: event.final,
        };
        // Finals log at info: at production log level this is the only positive
        // evidence that a user turn reached us, and its absence is the signature of
        // a transcript the provider never sent. Interim frames stay at debug so the
        // volume tracks turns rather than frames.
        const emitted = {
          transcriptionEvent,
          ordinal: event.ordinal,
          fromDeltaBuffer: !event.text,
        };
        if (event.final) {
          this.#logger.info(
            emitted,
            "Emitting input_audio_transcription_completed event"
          );
        } else {
          this.#logger.debug(
            { ...emitted, event },
            "Emitting input_audio_transcription_completed event"
          );
        }
        this.emit("input_audio_transcription_completed", transcriptionEvent);
      } else {
        // Info, not debug: this is a DROPPED user turn. It should be unreachable now
        // that deltas are buffered, so if it appears the provider sent us a frame
        // with neither `text` nor `delta` and the turn is gone.
        this.#logger.info(
          { event, ordinal: event.ordinal },
          "Skipping empty transcript event"
        );
      }

      if (event.final) {
        // Keep the ordinal: it stays the boundary marker for any further frame on
        // this same turn, and the next turn's ordinal resets the buffer anyway.
        this.#userTranscriptBuffer = "";
      }
    } else if (event.role === "agent") {
      // Handle agent transcript through the generation stream
      this.#handleAgentTranscript(event);
    }
  }


  #handleFunctionCall(event: api_proto.UltravoxFunctionCallMessage): void {
    this.#logger.debug("Function call received:", { event });

    if (!this.#fncCtx) {
      this.#logger.error("function call received but no fncCtx is available");
      return;
    }

    // Execute the function - the AgentActivity will handle creating conversation items
    this.#executeFunctionFromEvent(event);
  }

  async #executeFunction(toolCall: RealtimeToolCall): Promise<void> {
    if (!this.#fncCtx) {
      this.#logger.warn("No function context available");
      return;
    }

    const func = this.#fncCtx[toolCall.name];
    if (!func) {
      this.#logger.error(
        `No function with name ${toolCall.name} in function context`
      );
      return;
    }

    try {
      this.#logger.debug("Executing function:", toolCall.name);

      const result = await func.execute(toolCall.arguments, {
        toolCallId: toolCall.toolCallID,
        ctx: {} as any,
      } as any);

      // Send function result back to Ultravox
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        const functionResult: api_proto.UltravoxFunctionResultMessage = {
          type: "client_tool_result",
          invocationId: toolCall.toolCallID,
          result: JSON.stringify(result),
        };

        this.#logger.debug("Sending function result:", functionResult);
        this.#ws.send(JSON.stringify(functionResult));
      }

      // Emit a function_call_output item for interface parity
      this.emit("function_call_output", {
        id: toolCall.toolCallID,
        callId: toolCall.toolCallID,
        output: JSON.stringify(result),
      });
    } catch (error: unknown) {
      this.#logger.error(
        {
          error,
          toolCall,
          message: error instanceof Error ? error.message : String(error),
        },
        "Error executing function:"
      );

      // Send error result back to Ultravox
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        const functionResult: api_proto.UltravoxFunctionResultMessage = {
          type: "client_tool_result",
          invocationId: toolCall.toolCallID,
          errorType: "implementation-error",
          errorMessage: error instanceof Error ? error.message : String(error),
        };

        this.#logger.info(functionResult, "Sending function error result:");
        this.#ws.send(JSON.stringify(functionResult));
      }

      // Emit a function_call_output item indicating error
      this.emit("function_call_output", {
        id: toolCall.toolCallID,
        callId: toolCall.toolCallID,
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      });
    }
  }

  #handleExperimentalMessage(
    event: api_proto.UltravoxExperimentalMessage
  ): void {
    const message = event.message;
    if (
      message.type === "debug" &&
      message.message.startsWith("LLM response:")
    ) {
      // Handle LLM response
      this.#logger.debug("LLM response:", message.message);
    }
  }

  async #handleAudio(audioData: Buffer): Promise<void> {
    const { content } = this.#getContent();
    this.#audioBuffer.push(audioData);

    const generation = this.currentGeneration;

    if (!generation) {
      this.#logger.info("No current generation for audio frame, buffered");
      return;
    }

    // Process buffered audio data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any | undefined;
    while ((data = this.#audioBuffer.shift())) {
      const frames = this.#audioStream?.write(data);
      if (frames) {
        frames.forEach((frame: AudioFrame) => {
          // Track first token timestamp
          if (!generation._firstTokenTimestamp) {
            generation._firstTokenTimestamp = Date.now();
          }
          // Write to the proper audio channel for the agent
          if (generation.audioChannel) {
            generation.audioChannel.write(frame);
          } else {
            this.#logger.error(
              { generation },
              "No item generation for audio frame"
            );
          }
        });
      }
    }
  }

  /** Create an empty audio message with the given duration. */
  #createEmptyUserAudioMessage(_duration: number): llm.ChatMessage {
    // Stubbed: Ultravox does not require injecting mock audio to trigger responses
    return new llm.ChatMessage({ role: "user", content: [""] } as any);
  }

  /**
   * Try to recover from a text response to audio mode.
   *
   * @remarks
   * Sometimes the Ultravox API returns text instead of audio responses.
   * This method tries to recover from this by requesting a new response after deleting the text
   * response and creating an empty user audio message.
   */
  recoverFromTextResponse(itemId: string) {
    if (itemId) {
      this.conversation.item.delete(itemId);
    }
    this.conversation.item.create(this.#createEmptyUserAudioMessage(1));
    this.response.create();
  }

  /**
   * Process audio frame - no resampling needed since sample rates match
   * @param frame - The audio frame to process
   * @returns Generator yielding audio frames
   */
  private *resampleAudio(frame: AudioFrame): Generator<AudioFrame> {
    // Sample rates should now match (24kHz), so no resampling needed
    if (frame.sampleRate !== api_proto.SAMPLE_RATE) {
      this.#logger.warn(
        {
          frameSampleRate: frame.sampleRate,
          expectedSampleRate: api_proto.SAMPLE_RATE,
        },
        "Sample rate mismatch detected - audio quality may be affected"
      );
    }
    yield frame;
  }

  /**
   * Flush any buffered audio frames to the WebSocket
   */
  #flushAudioBuffer(): void {
    if (
      this.#audioBuffer.length > 0 &&
      this.#ws &&
      this.#ws.readyState === WebSocket.OPEN
    ) {
      this.#logger.debug(
        { bufferedFrames: this.#audioBuffer.length },
        "Flushing buffered audio frames"
      );
      for (const audioData of this.#audioBuffer) {
        try {
          this.#ws.send(audioData);
        } catch (error) {
          this.#logger.error({ error }, "Failed to send buffered audio frame");
        }
      }
      this.#audioBuffer = [];
    }
  }

  private createResponse({
    userInitiated,
    instructions,
    oldHandle,
  }: {
    userInitiated: boolean;
    instructions?: string;
    oldHandle?: CreateResponseHandle;
  }): CreateResponseHandle {
    const handle = oldHandle || new CreateResponseHandle({ instructions });
    if (oldHandle && instructions) {
      handle.instructions = instructions;
    }

    const eventId = shortuuid("response_create_");
    if (userInitiated) {
      this.responseCreatedFutures[eventId] = handle;
    }

    // Handle instructions like OpenAI implementation
    if (instructions) {
      this.instructions = instructions;
    }

    // For Ultravox, we don't send response.create events since Ultravox handles responses automatically
    // But we still need to track the handle for when the response actually starts

    return handle;
  }

  // Helper methods for creating LiveKit chat items from Ultravox events
  #createUserMessageFromTranscript(
    event: api_proto.UltravoxTranscriptMessage
  ): llm.ChatMessage {
    return llm.ChatMessage.create({
      id: shortuuid("user-message-"),
      role: "user",
      content: [event.text || ""],
    });
  }

  #createFunctionCallFromEvent(
    event: api_proto.UltravoxFunctionCallMessage
  ): llm.FunctionCall {
    return llm.FunctionCall.create({
      id: shortuuid("function-call-"),
      callId: event.invocationId,
      name: event.toolName,
      args: event.parameters,
    });
  }

  #createFunctionCallOutputFromResult(
    callId: string,
    result: any,
    isError: boolean = false
  ): llm.FunctionCallOutput {
    return llm.FunctionCallOutput.create({
      id: shortuuid("function-output-"),
      callId: callId,
      output: isError ? result.message || String(result) : result,
      isError: isError,
    });
  }

  #handleAgentTranscript(event: api_proto.UltravoxTranscriptMessage): void {
    // We don't bother passing up non-final transcripts to the agent generation stream
    //  as it buffers anyway. It isn't 100% clear that Ultravox will always send a
    //  final transcript with a "text" property, so we buffer deltas just in case,
    //  but we'll send the final "text" value instead if it's present.
    if (!event.final) {
      this.#agentTranscriptBuffer += event.delta || "";
      return;
    } else {
      event.text && (this.#agentTranscriptBuffer = event.text);
    }

    // Write agent transcript to the generation stream
    if (!this.currentGeneration) {
      this.#logger.warn(
        { event },
        "No current generation for agent transcript"
      );
      return;
    }

    // Track first token timestamp
    if (!this.currentGeneration._firstTokenTimestamp) {
      this.currentGeneration._firstTokenTimestamp = Date.now();
    }

    this.#logger.debug(
      { textChannel: this.currentGeneration.textChannel },
      "Writing agent transcript delta to generation stream"
    );
    
      this.currentGeneration.textChannel.write(this.#agentTranscriptBuffer);
      this.#logger.debug(
        { agentTranscriptBuffer: this.#agentTranscriptBuffer },
        "Wrote agent transcript delta to generation stream"
      );
      // Mark that we've written a final transcript
    
    
    // Reset buffer
    this.#agentTranscriptBuffer = "";
  }

  #executeFunctionFromEvent(
    event: api_proto.UltravoxFunctionCallMessage
  ): void {
    const func = this.#fncCtx![event.toolName];
    if (!func) {
      this.#logger.error(
        `No function with name ${event.toolName} in function context`
      );
      return;
    }

    this.#logger.debug(
      `Executing function: ${event.toolName} with arguments:`,
      event.parameters
    );

    /* NOT YET - we do the function call execute directly, here for now, rather than writing it to the stream
       because getting the results back in CtxUpdate seems unreliable, so we'll just do it here for now.
    // Write function call to the generation stream so AgentActivity can process it
    if (this.currentGeneration) {
      const functionCall = llm.FunctionCall.create({
        id: shortuuid("function-call-"),
        callId: event.invocationId,
        name: event.toolName,
        args: JSON.stringify(event.parameters)
      });
      this.currentGeneration.functionChannel.write(functionCall);
      this.#logger.debug({ functionCall }, "Wrote function call to generation stream");
    }
    */

    func.execute(event.parameters, {
      toolCallId: event.invocationId,
      ctx: {} as any,
    } as any).then((result: any) => {
      // Send result back to Ultravox
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        const functionResult: api_proto.UltravoxFunctionResultMessage = {
          type: "client_tool_result",
          invocationId: event.invocationId,
          result
        };
        this.#ws.send(JSON.stringify(functionResult));
      }
    }).catch((e: any) => {
      const error = e as Error
      this.#logger.error({ error, toolName: event.toolName }, 'Error executing function');

      // Send error back to Ultravox
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        const functionResult: api_proto.UltravoxFunctionResultMessage = {
          type: "client_tool_result",
          invocationId: event.invocationId,
          errorType: "implementation-error",
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        this.#ws.send(JSON.stringify(functionResult));
      }
    });
  }
}
