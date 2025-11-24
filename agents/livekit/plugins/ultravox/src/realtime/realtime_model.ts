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

type Modality = "text" | "audio";

interface ModelOptions {
  modalities: Modality[];
  instructions: string;
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

export class RealtimeModel extends llm.RealtimeModel {
  sampleRate = api_proto.SAMPLE_RATE;
  numChannels = api_proto.NUM_CHANNELS;
  inFrameSize = api_proto.IN_FRAME_SIZE;
  outFrameSize = api_proto.OUT_FRAME_SIZE;

  #defaultOpts: ModelOptions;
  #sessions: RealtimeSession[] = [];
  #client: UltravoxClient;
  constructor({
    modalities = ["text", "audio"],
    instructions = "",
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
  }: {
    modalities?: ["text", "audio"] | ["text"];
    instructions?: string;
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

    this.#defaultOpts = {
      modalities,
      instructions,
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
    };

    this.#client = new UltravoxClient(apiKey, baseURL);
  }

  get sessions(): RealtimeSession[] {
    return this.#sessions;
  }

  session(): RealtimeSession {
    const opts: ModelOptions = { ...this.#defaultOpts };

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
  #sendQueue = new Queue<any>();
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
  // Track last item ID for proper insertion order
  #lastItemId: string | undefined = undefined;
  constructor(
    realtimeModel: llm.RealtimeModel,
    opts: ModelOptions,
    client: UltravoxClient,
    { fncCtx, chatCtx }: { fncCtx?: llm.ToolContext; chatCtx?: llm.ChatContext }
  ) {
    super(realtimeModel);

    this.#opts = opts;
    this.#client = client;
    this.#fncCtx = fncCtx;
    this.#chatCtx = chatCtx;

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
    // IMPORTANT: only emit error if there are listeners; otherwise emit will throw an error
    this.emit("error", {
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
            },
          },
          firstSpeaker: this.#opts.firstSpeaker,
        };

        this.#logger.info({ modelData }, "Creating Ultravox call");
        const callResponse = await this.#client.createCall(modelData);
        this.#logger.info({ callResponse }, "Created Ultravox call");
        this.#callId = callResponse.callId;

        if (
          callResponse.ended ||
          !callResponse.callId ||
          !callResponse.joinUrl
        ) {
          throw new Error("Failed to create Ultravox call");
        }

        // Connect to Ultravox WebSocket
        const joinUrl = new URL(callResponse.joinUrl);
        joinUrl.searchParams.append("experimentalMessages", "debug");

        this.#logger.debug(
          "Connecting to Ultravox WebSocket at",
          joinUrl.toString()
        );
        this.#ws = new WebSocket(joinUrl.toString());

        this.#ws.onerror = (error) => {
          const errorMsg = "Ultravox WebSocket error: " + error.message;
          this.#logger.error({ error }, "Ultravox WebSocket error occurred");
          this.#sessionFailed = true;
          this.emitError({ error: new Error(errorMsg), recoverable: false });
          reject(new Error(errorMsg));
        };

        await once(this.#ws, "open");
        this.#closing = false;
        this.#sessionId = this.#callId;
        this.#expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

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
            this.#logger.debug({ event }, "onmessage");

            this.#handleMessage(event);
          }
        };

        const sendTask = async () => {
          while (
            this.#ws &&
            !this.#closing &&
            this.#ws.readyState === WebSocket.OPEN
          ) {
            try {
              const event = await this.#sendQueue.get();
              this.#logger.debug(`-> ${JSON.stringify(event)}`);
              this.#ws.send(JSON.stringify(event));
            } catch (error) {
              this.#logger.error("Error sending event:", error);
            }
          }
        };

        sendTask();

        this.#ws.onclose = () => {
          if (this.#expiresAt && Date.now() >= this.#expiresAt) {
            this.#closing = true;
          }
          if (!this.#closing) {
            const errorMsg = "Ultravox connection closed unexpectedly";
            this.#logger.error(
              { callId: this.#callId },
              "Ultravox WebSocket closed unexpectedly"
            );
            this.#sessionFailed = true;
            this.emitError({ error: new Error(errorMsg), recoverable: false });
            reject(new Error(errorMsg));
          }
          this.#ws = null;
          !this.#closing && this.close();
          resolve();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  async close() {
    this.#logger.info({ ws: this.#ws, call: this.#callId }, "closing call");
    if (!this.#ws) return;
    this.#closing = true;
    await this.#ws.close();
    this.#logger.debug({ callId: this.#callId }, "ws closed, deleting call");
    this.emit("close", { callId: this.#callId });
    this.#logger.debug({ callId: this.#callId }, "call close");
    await super.close();

    this.#logger.debug({ callId: this.#callId }, "call closed");
  }

  #handleMessage(event: api_proto.UltravoxMessage): void {
    this.#logger.debug({ event }, "handleMessage");
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

  #handleTranscript(event: api_proto.UltravoxTranscriptMessage): void {
    this.#logger.debug(
      { event },
      "handleTranscript - received transcript event"
    );

    if (event.role === "user") {
      // Emit input_speech_started when we first detect user speech (non-final transcript)
      // This interrupts any ongoing agent generation
      if (!this.userSpeechStartedEmitted && !event.final && event.text && event.text.trim().length > 0) {
        this.#logger.debug("Emitting input_speech_started on first user transcript");
        this.emit("input_speech_started", {
          itemId: "ultravox-user-input",
        } as InputSpeechStarted);
        this.userSpeechStartedEmitted = true;
      }
      
      // Only emit transcription events when there's actual text content
      if (event.text && event.text.trim().length > 0) {
        const transcriptionEvent = {
          itemId: shortuuid("user-transcript-"),
          transcript: event.text,
          isFinal: event.final,
        };
        this.#logger.debug(
          { transcriptionEvent, event },
          "Emitting input_audio_transcription_completed event"
        );
        this.emit("input_audio_transcription_completed", transcriptionEvent);
      } else {
        this.#logger.debug({ event }, "Skipping empty transcript event");
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
          result: JSON.stringify(result),
        };
        this.#ws.send(JSON.stringify(functionResult));
      }
    }).catch((error: any) => {
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
