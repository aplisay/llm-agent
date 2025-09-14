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
  initializeLogger,
  stream,
  shortuuid,
} from "@livekit/agents";
import { AudioFrame, combineAudioFrames } from "@livekit/rtc-node";
import { once } from "node:events";
import { WebSocket } from "ws";
// import type { GenerationCreatedEvent } from '@livekit/agents';
import * as api_proto from "./api_proto.js";
import { UltravoxClient } from "./ultravox_client.js";

interface ModelOptions {
  modalities: ["text", "audio"] | ["text"];
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
}

interface ResponseGeneration {
  messageChannel: stream.StreamChannel<llm.MessageGeneration>;
  functionChannel: stream.StreamChannel<llm.FunctionCall>;
  messages: Map<string, MessageGeneration>;

  /** @internal */
  _doneFut: Future;
  /** @internal */
  _createdTimestamp: number;
  /** @internal */
  _firstTokenTimestamp?: number;
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
  // Instructions handling like OpenAI
  public instructions?: string;
  // Agent transcript buffer for accumulating deltas
  #agentTranscriptBuffer: string = '';
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
      this.#logger.debug("No tools provided at session creation, waiting for updateTools");
    }
  }

  get chatCtx(): llm.ChatContext {
    return this.remoteChatCtx.toChatCtx();
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
    this.#chatCtx = chatCtx;
  }

  async updateTools(tools: llm.ToolContext): Promise<void> {
    this.#fncCtx = tools;
    
    // If the session hasn't started yet, start it now that we have tools
    if (!this.#task && tools && Object.keys(tools).length > 0) {
      this.#logger.debug("Starting session now that tools are available");
      this.#task = this.#start();
    } else if (this.#callId) {
      this.#logger.warn("Tools updated after session started - Ultravox doesn't support updating tools after call creation");
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
      for (const nf of this.#bstream.write(f.data.buffer)) {
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
            const event: api_proto.Realtime_SessionUpdatedEvent = {
              event_id: this.#generateEventId(),
              type: "session.updated",
              session: {
                id: this.#sessionId,
                object: "realtime.session",
                model: this.#opts.model,
                modalities: this.#opts.modalities,
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
            // Ultravox transport does not consume these. Treat as no-ops for transport
            // but keep local compatibility by emitting minimal events when possible.
            // For now, swallow and do not forward.
            return;
          default:
            break;
        }
      }
    } catch (err) {
      this.#logger.warn({ err }, "error handling client event locally");
    }
    this.#sendQueue.put(command);
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
        
        // Debug logging for audio format
        this.#logger.debug({
          sampleRate: frame.sampleRate,
          samplesPerChannel: frame.samplesPerChannel,
          channels: frame.channels,
          dataLength: audioData.length,
          expectedLength: frame.samplesPerChannel * frame.channels * 2 // s16le = 2 bytes per sample
        }, "Sending audio frame to Ultravox");
        
        this.#ws.send(audioData);
      } catch (error) {
        this.#logger.error({ error }, "Failed to send audio frame to Ultravox");
      }
    } else {
      this.#logger.warn("WebSocket not ready, buffering audio frame");
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

  private emitError({ error, recoverable }: { error: Error; recoverable: boolean }): void {
    // IMPORTANT: only emit error if there are listeners; otherwise emit will throw an error
    this.emit('error', {
      timestamp: Date.now(),
      label: 'ultravox-connection',
      error,
      recoverable,
    } as llm.RealtimeModelError);
  }

  #start(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        // Convert function context to Ultravox tools
        this.#logger.debug({ fncCtx: this.#fncCtx }, "Converting function context to Ultravox tools");
        const selectedTools: api_proto.UltravoxTool[] = [];
        if (this.#fncCtx) {
          this.#logger.debug({ fncCtxKeys: Object.keys(this.#fncCtx) }, "Function context keys");
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
        this.#logger.debug({ selectedToolsCount: selectedTools.length, selectedTools }, "Selected tools for Ultravox");

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
        this.emit("session_created", {
          event_id: this.#generateEventId(),
          type: "session.created",
          session: {
            id: this.#sessionId,
            object: "realtime.session",
            model: this.#opts.model,
            modalities: this.#opts.modalities,
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
            modalities: this.#opts.modalities,
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
            this.#logger.error({ callId: this.#callId }, "Ultravox WebSocket closed unexpectedly");
            this.#sessionFailed = true;
            this.emitError({ error: new Error(errorMsg), recoverable: false });
            reject(new Error(errorMsg));
          }
          this.#ws = null;
          this.close();
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
    this.#ws.close();
    if (this.#callId) {
      try {
        await this.#client.deleteCall(this.#callId);
      } catch (error) {
        this.#logger.error("Error deleting call:", error);
      }
    }
    this.emit('close', { callId: this.#callId });
    super.close();
    await this.#task;
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
      default:
        this.#logger.debug("Unknown message type:", (event as any).type);
    }
  }

  #handleStatus(event: api_proto.UltravoxStatusMessage): void {
    this.#logger.debug({ event }, "Status");

    // Map Ultravox status to OpenAI events
    if (event.state === "listening") {
      this.#endResponse();
      // Emit input speech started
      this.emit("input_speech_started", {
        itemId: "ultravox-user-input",
      } as InputSpeechStarted);
    } else if (event.state === "thinking") {
    } else if (event.state === "speaking") {
      // If we have just moved into the speaking state, we need to create a new response
      // and create a new audio byte stream for the response. If we are already in the speaking state,
      // then nothing needs to be done.
      if (!this.#currentResponseId) {
        this.#currentResponseId = this.#generateEventId();
        this.#logger.info(
          { responseId: this.#currentResponseId },
          "Creating new response"
        );

        // Create a new audio byte stream for the response
        this.#audioStream = new AudioByteStream(
          api_proto.SAMPLE_RATE,
          api_proto.NUM_CHANNELS,
          api_proto.OUT_FRAME_SIZE
        );

        // Create proper response generation like OpenAI
        this.currentGeneration = {
          messageChannel: stream.createStreamChannel<llm.MessageGeneration>(),
          functionChannel: stream.createStreamChannel<llm.FunctionCall>(),
          messages: new Map(),
          _doneFut: new Future(),
          _createdTimestamp: Date.now(),
        };

        // Build generation event and resolve client future (if any) before emitting,
        // matching Python behavior.
        const generationEv = {
          messageStream: this.currentGeneration.messageChannel.stream(),
          functionStream: this.currentGeneration.functionChannel.stream(),
          userInitiated: false,
        } as llm.GenerationCreatedEvent;

        // Check if this is a user-initiated response
        const pendingHandles = Object.values(this.responseCreatedFutures);
        if (pendingHandles.length > 0) {
          const handle = pendingHandles[0];
          delete this.responseCreatedFutures[
            Object.keys(this.responseCreatedFutures)[0]
          ];
          generationEv.userInitiated = true;
          if (!handle.doneFut.done) {
            handle.doneFut.resolve(generationEv);
          }
        }

        this.emit("generation_created", generationEv);

        const response: RealtimeResponse = {
          id: this.#currentResponseId,
          status: "in_progress",
          statusDetails: null,
          usage: null,
          output: [],
          doneFut: new Future(),
          createdTimestamp: Date.now(),
        };
        this.#pendingResponses[this.#currentResponseId] = response;

        // Emit response created event
        this.emit("response_created", response);

        // Emit response output added for audio content
        if (this.#currentResponseId) {
          const output: RealtimeOutput = {
            responseId: this.#currentResponseId,
            itemId: `output-${this.#currentOutputIndex}`,
            outputIndex: this.#currentOutputIndex,
            role: "assistant",
            type: "message",
            content: [],
            doneFut: new Future(),
          };

          const response = this.#pendingResponses[this.#currentResponseId];
          if (response) {
            response.output.push(output);
          }

          // Emit response output added event
          this.emit("response_output_added", output);

          // Add audio content
          const content: RealtimeContent = {
            responseId: this.#currentResponseId,
            itemId: output.itemId,
            outputIndex: this.#currentOutputIndex,
            contentIndex: this.#currentContentIndex,
            text: "",
            audio: [],
            textStream: new AsyncIterableQueue<string>(),
            audioStream: new AsyncIterableQueue<AudioFrame>(),
            toolCalls: [],
            contentType: "audio",
          };

          output.content.push(content);
          response!.firstTokenTimestamp = Date.now();
          this.emit("response_content_added", content);

          // Create MessageGeneration and connect to stream channels like OpenAI
          const itemGeneration: MessageGeneration = {
            messageId: output.itemId,
            textChannel: stream.createStreamChannel<string>(),
            audioChannel: stream.createStreamChannel<AudioFrame>(),
            audioTranscript: "",
          };

          // Write to the message channel to make audio available to the agent
          this.currentGeneration!.messageChannel.write({
            messageId: output.itemId,
            textStream: itemGeneration.textChannel.stream(),
            audioStream: itemGeneration.audioChannel.stream(),
          });

          this.currentGeneration!.messages.set(output.itemId, itemGeneration);
          this.currentGeneration!._firstTokenTimestamp = Date.now();
        }
      }
    }
  }

  #handleTranscript(event: api_proto.UltravoxTranscriptMessage): void {
    this.#logger.info({ event }, "handleTranscript - received transcript event");
    
    if (event.role === "user") {
      // Only emit transcription events when there's actual text content
      if (event.text && event.text.trim().length > 0) {
        const transcriptionEvent = {
          itemId: shortuuid('user-transcript-'),
          transcript: event.text,
          isFinal: event.final,
        };
        this.#logger.info({ transcriptionEvent, event }, "Emitting input_audio_transcription_completed event");
        this.emit('input_audio_transcription_completed', transcriptionEvent);
      } else {
        this.#logger.debug({ event }, "Skipping empty transcript event");
      }
    } else if (event.role === "agent") {
      // Handle agent transcript through the generation stream
      this.#handleAgentTranscript(event);
    }
  }

  #endResponse() {
    const { content, output, response } = this.#getContent();
    if (!content || !output || !response) {
      return;
    }

    content.textStream.close();
    content.audioStream.close();

    // Close stream channels like OpenAI implementation
    if (this.currentGeneration) {
      for (const generation of this.currentGeneration.messages.values()) {
        generation.textChannel.close();
        generation.audioChannel.close();
      }
      this.currentGeneration.functionChannel.close();
      this.currentGeneration.messageChannel.close();
      this.currentGeneration._doneFut.resolve();
      this.currentGeneration = undefined;
    }

    // Emit audio done event
    this.emit("response_audio_done", content);
    // Emit text done event
    this.emit("response_text_done", content);
    // Emit content part done
    this.emit("response_content_done", content);
    // Emit output item done
    this.emit("response_output_done", output);
    // Emit response done
    this.emit("response_done", response);

    // Reset for next response
    this.#logger.info(
      { responseId: this.#currentResponseId },
      "Ending response"
    );
    this.#currentResponseId = null;
    this.#currentOutputIndex = 0;
    this.#currentContentIndex = 0;
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
    if (!this.#currentResponseId) {
      this.#logger.info(
        { currentResponseId: this.#currentResponseId },
        "No current response id, buffering audio"
      );
      this.#audioBuffer.push(audioData);
      return;
    }
    const { content } = this.#getContent();
    this.#audioBuffer.push(audioData);

    // Process buffered audio data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any | undefined;
    while ((data = this.#audioBuffer.shift())) {
      const frames = this.#audioStream?.write(data);
      if (frames) {
        frames.forEach((frame: AudioFrame) => {
          // Add to content for compatibility
          content!.audio.push(frame);
          content!.audioStream.put(frame);

          // Also write to the proper audio channel for the agent
          if (this.currentGeneration) {
            const itemGeneration = this.currentGeneration.messages.get(
              content!.itemId
            );
            if (itemGeneration) {
              itemGeneration.audioChannel.write(frame);
            }
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
      this.#logger.warn({
        frameSampleRate: frame.sampleRate,
        expectedSampleRate: api_proto.SAMPLE_RATE
      }, "Sample rate mismatch detected - audio quality may be affected");
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
  #createUserMessageFromTranscript(event: api_proto.UltravoxTranscriptMessage): llm.ChatMessage {
    return llm.ChatMessage.create({
      id: shortuuid('user-message-'),
      role: 'user',
      content: [event.text || ''],
    });
  }

  #createFunctionCallFromEvent(event: api_proto.UltravoxFunctionCallMessage): llm.FunctionCall {
    return llm.FunctionCall.create({
      id: shortuuid('function-call-'),
      callId: event.invocationId,
      name: event.toolName,
      args: event.parameters,
    });
  }

  #createFunctionCallOutputFromResult(callId: string, result: any, isError: boolean = false): llm.FunctionCallOutput {
    return llm.FunctionCallOutput.create({
      id: shortuuid('function-output-'),
      callId: callId,
      output: isError ? result.message || String(result) : result,
      isError: isError,
    });
  }

  #insertConversationItem(item: llm.ChatItem, previousItemId?: string): void {
    try {
      const actualPreviousId = previousItemId || this.#lastItemId;
      this.remoteChatCtx.insert(actualPreviousId, item);
      this.#lastItemId = item.id; // Update last item ID
      this.#logger.debug({ itemId: item.id, itemType: item.constructor.name, previousItemId: actualPreviousId }, 'Inserted conversation item');
    } catch (error) {
      this.#logger.error({ error, itemId: item.id }, 'Failed to insert conversation item');
    }
  }

  #handleAgentTranscript(event: api_proto.UltravoxTranscriptMessage): void {

    // We don't bother passing up non-final transcripts to the agent generation stream
    //  as it buffers anyway. It isn't 100% clear that Ultravox will always send a
    //  final transcript with a "text" property, so we buffer deltas just in case,
    //  but we'll send the final "text" value instead if it's present.
    if (!event.final) {
      this.#agentTranscriptBuffer += event.delta || '';
      return;
    }
    else {
      event.text && (this.#agentTranscriptBuffer = event.text);
    }

   
    // Write agent transcript to the generation stream
    if (!this.currentGeneration) {
      this.#logger.warn({ event }, "No current generation for agent transcript");
      return;
    }

    // Create a message generation if one doesn't exist
    if (this.currentGeneration.messages.size === 0) {
      const messageId = shortuuid('agent-message-');
      const itemGeneration: MessageGeneration = {
        messageId: messageId,
        textChannel: stream.createStreamChannel<string>(),
        audioChannel: stream.createStreamChannel<AudioFrame>(),
        audioTranscript: '',
      };
      
      this.currentGeneration.messages.set(messageId, itemGeneration);
      this.currentGeneration.messageChannel.write({
        messageId: messageId,
        textStream: itemGeneration.textChannel.stream(),
        audioStream: itemGeneration.audioChannel.stream(),
      });
      this.#logger.debug({ messageId }, "Created message generation for agent transcript");
    }

    // Get the current message generation
    const messageGenerations = Array.from(this.currentGeneration.messages.values());
    const currentMessage = messageGenerations[messageGenerations.length - 1];
      currentMessage.textChannel.write(this.#agentTranscriptBuffer);
      this.#logger.debug({ agentTranscriptBuffer: this.#agentTranscriptBuffer }, "Wrote agent transcript delta to generation stream");
      // Reset buffer
      this.#agentTranscriptBuffer = '';
  }

  #executeFunctionFromEvent(event: api_proto.UltravoxFunctionCallMessage): void {
    const func = this.#fncCtx![event.toolName];
    if (!func) {
      this.#logger.error(`No function with name ${event.toolName} in function context`);
      return;
    }

    this.#logger.debug(`Executing function: ${event.toolName} with arguments:`, event.parameters);

    // Write function call to the generation stream so AgentActivity can process it
    if (this.currentGeneration) {
      const functionCall = llm.FunctionCall.create({
        id: shortuuid('function-call-'),
        callId: event.invocationId,
        name: event.toolName,
        args: event.parameters,
      });
      this.currentGeneration.functionChannel.write(functionCall);
      this.#logger.debug({ functionCall }, "Wrote function call to generation stream");
    }

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
