/**
 * The ElevenLabs Agents conversation as a LiveKit `RealtimeModel`.
 *
 * One conversation WebSocket per session, joined with a signed URL for the
 * hosted agent that matches this session's configuration (elevenlabs-agents.ts).
 * Caller audio goes up as `user_audio_chunk` messages; the agent's speech comes
 * back as `audio` events and is handed to the SDK as one generation per reply,
 * its text (`agent_response`) written to the generation's text stream so the
 * SDK's transcript synchroniser can report what was heard after a barge-in.
 * Tools are ElevenLabs client tools, run here against the session's ToolContext
 * and answered with `client_tool_result`, as the Ultravox plugin does.
 *
 * The platform speaks to the agent through user-side messages: the opening
 * instruction when there is no verbatim greeting, `generateReply`'s
 * instructions (the inactivity kick) and new user text in the chat context
 * (keypad digits). ElevenLabs echoes some back as a user transcript, which is
 * dropped: the SDK logged the platform's own row already.
 */
import { Future, llm, log, shortuuid, stream } from "@livekit/agents";
import { AudioFrame, AudioResampler } from "@livekit/rtc-node";
import { WebSocket } from "ws";
import type { Agent } from "./api-client.js";
import * as el from "./elevenlabs-agents.js";
import { ElevenLabsAgentsClient } from "./elevenlabs-agents-client.js";
import { FrameAccumulator } from "../plugins/ultravox/src/realtime/frame_accumulator.js";

type Dict = Record<string, unknown>;

/** Caller audio goes up in chunks of about this long. */
export const SEND_CHUNK_MS = 100;
/**
 * ElevenLabs times a reply's playback against the caller audio it receives, so
 * silence is sent whenever none has gone out for this long.
 */
export const SILENCE_FILL_MS = 200;
/** A `generateReply` with no reply from the agent resolves with an empty generation after this. */
export const REPLY_TIMEOUT_MS = 15_000;
/** Output frames handed to the SDK: 20 ms at the agent's output rate. */
const OUT_FRAME_MS = 20;
const ECHO_MEMORY = 8;

export interface ElevenLabsModelOptions {
  /** The ElevenLabs LLM id, the segment after `livekit:elevenlabs/`. */
  model: string;
  instructions: string;
  voice?: string;
  callId?: string;
  /** The agent, for the hosted configuration and the per-conversation overrides. */
  agent: Agent;
  /** The platform's opening instruction on a handover or hand-back leg. */
  opening?: string;
  apiKey: string;
  baseURL?: string;
  /** Tests: a stand-in for the REST client. */
  client?: ElevenLabsAgentsClient;
  silenceFillMs?: number;
  replyTimeoutMs?: number;
}

export interface ProviderEndedInfo {
  code?: number;
  reason?: string;
}

function functionToolsOf(ctx: llm.ToolContext | Record<string, any> | undefined): Record<string, any> {
  if (!ctx) return {};
  return "functionTools" in ctx ? (ctx as any).functionTools : ctx;
}

/** The tool schemas the hosted agent is configured with, from the SDK's ToolContext. */
export function toolSchemasOf(ctx: llm.ToolContext | Record<string, any> | undefined): el.ToolSchema[] {
  return Object.entries(functionToolsOf(ctx)).map(([name, tool]) => ({
    name,
    description: (tool as any)?.description,
    parameters: (tool as any)?.parameters,
  }));
}

function rateOf(format: unknown, fallback: number): number {
  if (typeof format === "string" && format.startsWith("pcm_")) {
    const n = Number(format.slice(4));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

interface Generation {
  eventId: number;
  messageChannel: stream.StreamChannel<llm.MessageGeneration>;
  functionChannel: stream.StreamChannel<llm.FunctionCall>;
  textChannel: stream.StreamChannel<string>;
  audioChannel: stream.StreamChannel<AudioFrame>;
  textWritten: boolean;
  done: boolean;
}

export class ElevenLabsRealtimeModel extends llm.RealtimeModel {
  readonly #opts: ElevenLabsModelOptions;
  readonly #client: ElevenLabsAgentsClient;
  #sessions: ElevenLabsRealtimeSession[] = [];
  #providerEndedCallback?: (info: ProviderEndedInfo) => void;
  #primarySession?: ElevenLabsRealtimeSession;
  #nextSessionPrimary = false;

  constructor(opts: ElevenLabsModelOptions) {
    super({
      messageTruncation: false,
      // ElevenLabs decides the turns; the SDK neither commits audio nor refuses uninterruptible replies.
      turnDetection: true,
      userTranscription: true,
      autoToolReplyGeneration: false,
      manualFunctionCalls: false,
      audioOutput: true,
    });
    if (!opts.apiKey) {
      throw new Error("ElevenLabs API key is required (ELEVENLABS_API_KEY)");
    }
    if (!opts.agent) {
      throw new Error("ElevenLabs realtime model needs the agent definition");
    }
    this.#opts = opts;
    this.#client = opts.client ?? new ElevenLabsAgentsClient(opts.apiKey, { baseUrl: opts.baseURL });
  }

  get model(): string {
    return this.#opts.model;
  }

  get sessions(): ElevenLabsRealtimeSession[] {
    return this.#sessions;
  }

  getActiveSession(): ElevenLabsRealtimeSession | undefined {
    return this.#sessions[0];
  }

  /** The runtime's provider-ended teardown hook (provider-ended.ts). */
  setProviderEndedCallback(cb: (info: ProviderEndedInfo) => void): void {
    this.#providerEndedCallback = cb;
  }

  /** @internal */
  _notifyProviderEnded(session: ElevenLabsRealtimeSession, info: ProviderEndedInfo): void {
    if (session !== this.#primarySession) return;
    this.#providerEndedCallback?.(info);
  }

  setNextSessionPrimary(): void {
    this.#nextSessionPrimary = true;
  }

  clearNextSessionPrimary(): void {
    this.#nextSessionPrimary = false;
  }

  session(): ElevenLabsRealtimeSession {
    const session = new ElevenLabsRealtimeSession(this, this.#opts, this.#client);
    this.#sessions.push(session);
    if (this.#nextSessionPrimary || !this.#primarySession) this.#primarySession = session;
    this.#nextSessionPrimary = false;
    return session;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#sessions.map((s) => s.close()));
  }
}

export class ElevenLabsRealtimeSession extends llm.RealtimeSession {
  readonly #opts: ElevenLabsModelOptions;
  readonly #client: ElevenLabsAgentsClient;
  readonly #logger = log();
  #chatCtx = new llm.ChatContext();
  #fncCtx: llm.ToolContext | undefined;
  /** The prompt the conversation opens with; `updateInstructions` sets it before the start. */
  instructions: string;
  #ws: WebSocket | undefined;
  #starting = false;
  #started = false;
  #ready = false;
  #closing = false;
  #pending: Dict[] = [];
  agentId: string | undefined;
  conversationId: string | undefined;

  #inRate = el.INPUT_SAMPLE_RATE;
  #outRate = el.OUTPUT_SAMPLE_RATE;
  #resampler: AudioResampler | undefined;
  #resamplerInputRate = 0;
  #sendBuffer = new Uint8Array(0);
  #lastAudioSentAt = 0;
  #fillTimer: NodeJS.Timeout | undefined;
  #accumulator: FrameAccumulator | undefined;

  #generation: Generation | undefined;
  #responseText = new Map<number, string>();
  #replyHandles: { future: Future<llm.GenerationCreatedEvent>; timer: NodeJS.Timeout }[] = [];
  #injected: string[] = [];
  #sentMessageIds = new Set<string>();
  #audioMessageIds = new Set<string>();
  #completedToolCalls = new Set<string>();

  constructor(realtimeModel: ElevenLabsRealtimeModel, opts: ElevenLabsModelOptions, client: ElevenLabsAgentsClient) {
    super(realtimeModel);
    this.#opts = opts;
    this.#client = client;
    this.instructions = opts.instructions;
  }

  // ---- the RealtimeSession contract -------------------------------------------------

  get chatCtx(): llm.ChatContext {
    return this.#chatCtx.copy();
  }

  get tools(): llm.ToolContext {
    return this.#fncCtx ?? llm.ToolContext.empty();
  }

  async updateInstructions(instructions: string): Promise<void> {
    if (this.#started && instructions !== this.instructions) {
      // The prompt is fixed at the conversation's start; a handover restarts the stack.
      this.#logger.debug("ElevenLabs: instructions updated after the conversation started; ignored");
      return;
    }
    this.instructions = instructions;
  }

  async updateChatCtx(chatCtx: llm.ChatContext): Promise<void> {
    const diff = llm.computeChatCtxDiff(this.#chatCtx, chatCtx);
    for (const [, itemId] of diff.toCreate) {
      const item = chatCtx.getById(itemId);
      if (!item || item.type !== "message" || item.role !== "user" || !item.id) continue;
      if (this.#sentMessageIds.has(item.id)) continue;
      this.#sentMessageIds.add(item.id);
      // A message the SDK built from the agent's own transcript is already on the ElevenLabs side.
      if (this.#audioMessageIds.has(item.id)) continue;
      const text = (item.textContent || "").trim();
      if (!text) continue;
      await this.#sendUserMessage(text, el.isDtmfText(text) ? "dtmf" : undefined);
    }
    this.#chatCtx = chatCtx.copy();
  }

  async updateTools(tools: llm.ToolContext): Promise<void> {
    this.#fncCtx = tools;
    if (!this.#started && !this.#starting) {
      void this.#start();
    } else if (this.#started) {
      this.#logger.warn("ElevenLabs: tools updated after the conversation started; the hosted agent keeps its tools");
    }
  }

  updateOptions(_options: { toolChoice?: llm.ToolChoice | null }): void {}

  pushAudio(frame: AudioFrame): void {
    if (!this.#started && !this.#starting) {
      // A caller spoke before the SDK sent the tools: open the conversation anyway.
      void this.#start();
    }
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    for (const f of this.#resample(frame)) {
      const bytes = new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength);
      const merged = new Uint8Array(this.#sendBuffer.length + bytes.length);
      merged.set(this.#sendBuffer, 0);
      merged.set(bytes, this.#sendBuffer.length);
      this.#sendBuffer = merged;
    }
    const chunkBytes = Math.floor((this.#inRate * 2 * SEND_CHUNK_MS) / 1000);
    let offset = 0;
    while (this.#sendBuffer.length - offset >= chunkBytes) {
      this.#sendAudioChunk(this.#sendBuffer.slice(offset, offset + chunkBytes));
      offset += chunkBytes;
    }
    if (offset > 0) this.#sendBuffer = this.#sendBuffer.slice(offset);
  }

  async generateReply(instructions?: string): Promise<llm.GenerationCreatedEvent> {
    if (instructions && instructions.trim()) {
      await this.#sendUserMessage(el.instructionMessage(instructions));
    }
    const future = new Future<llm.GenerationCreatedEvent>();
    const timer = setTimeout(() => {
      // Nothing came back: hand the SDK an empty generation so its speech handle completes.
      this.#replyHandles = this.#replyHandles.filter((h) => h.future !== future);
      if (!future.done) future.resolve(this.#emptyGeneration());
    }, this.#opts.replyTimeoutMs ?? REPLY_TIMEOUT_MS);
    this.#replyHandles.push({ future, timer });
    return future.await;
  }

  async commitAudio(): Promise<void> {}

  async clearAudio(): Promise<void> {}

  async interrupt(): Promise<void> {
    // ElevenLabs stops speaking by itself when the caller talks over it.
  }

  async truncate(_options: { messageId: string; audioEndMs: number }): Promise<void> {}

  async close(): Promise<void> {
    this.#closing = true;
    this.#stopFilling();
    for (const h of this.#replyHandles) {
      clearTimeout(h.timer);
      if (!h.future.done) h.future.resolve(this.#emptyGeneration());
    }
    this.#replyHandles = [];
    this.#closeGeneration();
    const ws = this.#ws;
    this.#ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch (e) {
        this.#logger.debug({ e }, "ElevenLabs: closing the socket raised");
      }
    }
    this.#resampler?.close();
    this.#resampler = undefined;
    this.emit("close", { conversationId: this.conversationId });
    await super.close();
  }

  // ---- the conversation ---------------------------------------------------------------

  /** The hosted agent's configuration for this session (tests and diagnostics). */
  get config(): Dict {
    return el.agentConfig(this.#opts.agent, { llm: this.#opts.model, toolSchemas: toolSchemasOf(this.#fncCtx) });
  }

  get overrides(): Dict {
    const { firstMessage } = el.openingPlan(this.#opts.agent, this.#opts.opening);
    return el.conversationOverrides(this.#opts.agent, {
      systemPrompt: this.instructions || this.#opts.instructions,
      firstMessage,
      maxDurationSecs: el.maxDurationSeconds(this.#opts.agent),
    });
  }

  async #start(): Promise<void> {
    this.#starting = true;
    try {
      const { agentId, url } = await this.#client.conversationUrl(this.config);
      if (this.#closing) return;
      this.agentId = agentId;
      const ws = new WebSocket(url);
      this.#ws = ws;
      ws.on("message", (data) => this.#onMessage(data));
      ws.on("close", (code, reason) => this.#onClose(ws, code, reason.toString()));
      ws.on("error", (error) => {
        if (ws !== this.#ws || this.#closing) return;
        this.#logger.error({ error: error.message, callId: this.#opts.callId }, "ElevenLabs websocket error");
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", (error) => reject(error));
      });
      this.#started = true;
      this.#send(el.initiationMessage(this.overrides));
      this.#logger.info({ agentId, callId: this.#opts.callId }, "ElevenLabs conversation opened");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.#logger.error({ error: err.message, callId: this.#opts.callId }, "ElevenLabs conversation failed to start");
      this.#emitError(err, false);
      (this.realtimeModel as ElevenLabsRealtimeModel)._notifyProviderEnded(this, { reason: `connect failed: ${err.message}` });
    } finally {
      this.#starting = false;
    }
  }

  #send(message: Dict): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      this.#logger.debug({ e }, "ElevenLabs: send failed");
    }
  }

  #sendAudioChunk(chunk: Uint8Array): void {
    this.#lastAudioSentAt = Date.now();
    this.#send({ user_audio_chunk: Buffer.from(chunk).toString("base64") });
  }

  *#resample(frame: AudioFrame): Generator<AudioFrame> {
    if (frame.sampleRate === this.#inRate) {
      yield frame;
      return;
    }
    if (!this.#resampler || this.#resamplerInputRate !== frame.sampleRate) {
      this.#resampler?.close();
      this.#resampler = new AudioResampler(frame.sampleRate, this.#inRate, 1);
      this.#resamplerInputRate = frame.sampleRate;
    }
    for (const f of this.#resampler.push(frame)) yield f;
  }

  #startFilling(): void {
    const interval = this.#opts.silenceFillMs ?? SILENCE_FILL_MS;
    const silence = new Uint8Array(Math.floor((this.#inRate * 2 * interval) / 1000));
    this.#lastAudioSentAt = Date.now();
    this.#fillTimer = setInterval(() => {
      if (Date.now() - this.#lastAudioSentAt >= interval) this.#sendAudioChunk(silence);
    }, interval);
  }

  #stopFilling(): void {
    if (this.#fillTimer) clearInterval(this.#fillTimer);
    this.#fillTimer = undefined;
  }

  async #sendUserMessage(text: string, sourceMedium?: string): Promise<void> {
    const message: Dict = { type: "user_message", text };
    if (sourceMedium) message.source_medium = sourceMedium;
    this.#injected.push(text);
    if (this.#injected.length > ECHO_MEMORY) this.#injected.shift();
    if (!this.#ready) {
      this.#pending.push(message);
      return;
    }
    this.#send(message);
  }

  // ---- inbound -------------------------------------------------------------------------

  #onMessage(data: WebSocket.RawData): void {
    let message: Dict;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    try {
      this.handleMessage(message);
    } catch (e) {
      this.#logger.error({ e, type: message?.type }, "ElevenLabs: handling a message failed");
    }
  }

  /** Dispatch one server message. Public for the tests. */
  handleMessage(message: Dict): void {
    const kind = message.type;
    switch (kind) {
      case "audio":
        this.#handleAudio((message.audio_event as Dict) || {});
        break;
      case "ping": {
        const eventId = (message.ping_event as Dict | undefined)?.event_id;
        this.#send({ type: "pong", event_id: eventId });
        break;
      }
      case "agent_response": {
        const ev = (message.agent_response_event as Dict) || {};
        const eventId = Number(ev.event_id);
        if (Number.isFinite(eventId)) {
          const text = el.stripAudioTags(String(ev.agent_response || ""));
          this.#responseText.set(eventId, text);
          if (this.#generation && this.#generation.eventId === eventId) this.#writeText(this.#generation);
        }
        break;
      }
      case "agent_response_correction": {
        const ev = (message.agent_response_correction_event as Dict) || {};
        this.#logger.debug({ corrected: ev.corrected_agent_response }, "ElevenLabs: reply cut short");
        this.#endResponse(Number(ev.event_id));
        break;
      }
      case "agent_response_complete": {
        const ev = (message.agent_response_complete_event as Dict) || {};
        this.#endResponse(Number(ev.event_id));
        break;
      }
      case "user_transcript": {
        const ev = (message.user_transcription_event as Dict) || {};
        this.#handleUserTranscript(String(ev.user_transcript || ""));
        break;
      }
      case "interruption":
        this.#handleInterruption();
        break;
      case "client_tool_call":
        this.#handleToolCall((message.client_tool_call as Dict) || {});
        break;
      case "conversation_initiation_metadata":
        this.#handleInitiation((message.conversation_initiation_metadata_event as Dict) || {});
        break;
      case "agent_tool_response": {
        const ev = (message.agent_tool_response as Dict) || {};
        this.#logger.debug({ tool: ev.tool_name, status: ev.status }, "ElevenLabs tool response");
        break;
      }
      case "client_error": {
        const ev = (message.error_event as Dict) || {};
        this.#logger.warn({ code: ev.code, error: ev.error_name, message: ev.message }, "ElevenLabs client error");
        break;
      }
      case "vad_score":
      case "internal_turn_probability":
      case "internal_tentative_agent_response":
        break;
      default:
        this.#logger.debug({ type: kind }, "ElevenLabs: unhandled message");
    }
  }

  #handleInitiation(ev: Dict): void {
    this.conversationId = typeof ev.conversation_id === "string" ? ev.conversation_id : undefined;
    this.#outRate = rateOf(ev.agent_output_audio_format, el.OUTPUT_SAMPLE_RATE);
    this.#inRate = rateOf(ev.user_input_audio_format, el.INPUT_SAMPLE_RATE);
    this.#accumulator = new FrameAccumulator(this.#outRate, 1, Math.floor((this.#outRate * OUT_FRAME_MS) / 1000));
    this.#ready = true;
    this.#logger.info(
      { conversationId: this.conversationId, outRate: this.#outRate, inRate: this.#inRate, callId: this.#opts.callId },
      "ElevenLabs conversation ready",
    );
    this.emit("session_created", { conversationId: this.conversationId });
    const { openingMessage } = el.openingPlan(this.#opts.agent, this.#opts.opening);
    if (openingMessage) void this.#sendUserMessage(openingMessage);
    const pending = this.#pending;
    this.#pending = [];
    for (const message of pending) this.#send(message);
    this.#startFilling();
  }

  #handleAudio(ev: Dict): void {
    const data = ev.audio_base_64;
    if (typeof data !== "string" || !data) return;
    const eventId = Number(ev.event_id);
    const id = Number.isFinite(eventId) ? eventId : -1;
    if (this.#generation && this.#generation.eventId !== id) this.#closeGeneration();
    if (!this.#generation) this.#startGeneration(id);
    const generation = this.#generation!;
    const bytes = Buffer.from(data, "base64");
    const frames = this.#accumulator?.write(bytes) ?? [];
    for (const frame of frames) generation.audioChannel.write(frame);
  }

  #startGeneration(eventId: number): Generation {
    const generation: Generation = {
      eventId,
      messageChannel: stream.createStreamChannel<llm.MessageGeneration>(),
      functionChannel: stream.createStreamChannel<llm.FunctionCall>(),
      textChannel: stream.createStreamChannel<string>(),
      audioChannel: stream.createStreamChannel<AudioFrame>(),
      textWritten: false,
      done: false,
    };
    this.#generation = generation;
    generation.messageChannel.write({
      messageId: `elevenlabs-${eventId}-${shortuuid("")}`,
      textStream: generation.textChannel.stream(),
      audioStream: generation.audioChannel.stream(),
      modalities: Promise.resolve(["text", "audio"]),
    } as llm.MessageGeneration);
    this.#writeText(generation);
    const handle = this.#replyHandles.shift();
    const event: llm.GenerationCreatedEvent = {
      messageStream: generation.messageChannel.stream(),
      functionStream: generation.functionChannel.stream(),
      userInitiated: Boolean(handle),
    };
    if (handle) {
      clearTimeout(handle.timer);
      if (!handle.future.done) handle.future.resolve(event);
    }
    this.emit("generation_created", event);
    return generation;
  }

  /** The reply's text, once known, written once per generation. */
  #writeText(generation: Generation): void {
    if (generation.textWritten || generation.done) return;
    const text = this.#responseText.get(generation.eventId);
    if (text === undefined) return;
    if (text) generation.textChannel.write(text);
    generation.textWritten = true;
  }

  #closeGeneration(): void {
    const generation = this.#generation;
    if (!generation) return;
    this.#writeText(generation);
    generation.done = true;
    generation.audioChannel.close();
    generation.textChannel.close();
    generation.functionChannel.close();
    generation.messageChannel.close();
    this.#responseText.delete(generation.eventId);
    this.#generation = undefined;
  }

  /** A reply ended (completed or cut short). A text-only reply still becomes a generation. */
  #endResponse(eventId: number): void {
    if (!Number.isFinite(eventId)) return;
    if (this.#generation && this.#generation.eventId === eventId) {
      this.#closeGeneration();
      return;
    }
    if (this.#responseText.has(eventId)) {
      if (this.#generation) this.#closeGeneration();
      this.#startGeneration(eventId);
      this.#closeGeneration();
    }
  }

  #emptyGeneration(): llm.GenerationCreatedEvent {
    const messageChannel = stream.createStreamChannel<llm.MessageGeneration>();
    const functionChannel = stream.createStreamChannel<llm.FunctionCall>();
    messageChannel.close();
    functionChannel.close();
    return { messageStream: messageChannel.stream(), functionStream: functionChannel.stream(), userInitiated: true };
  }

  #handleInterruption(): void {
    // The SDK interrupts the current speech and clears what the room still holds.
    this.emit("input_speech_started", {});
    this.emit("input_speech_stopped", { userTranscriptionEnabled: false });
    this.#closeGeneration();
  }

  #handleUserTranscript(text: string): void {
    const transcript = text.trim();
    if (!transcript) return;
    const echo = this.#injected.indexOf(transcript);
    if (echo !== -1) {
      this.#injected.splice(echo, 1);
      return;
    }
    const itemId = shortuuid("elevenlabs-user-");
    this.#audioMessageIds.add(itemId);
    this.#logger.info({ transcript, callId: this.#opts.callId }, "ElevenLabs user transcript");
    this.emit("input_audio_transcription_completed", { itemId, transcript, isFinal: true });
  }

  #handleToolCall(call: Dict): void {
    const name = typeof call.tool_name === "string" ? call.tool_name : "";
    const toolCallId = typeof call.tool_call_id === "string" ? call.tool_call_id : "";
    if (!name || !toolCallId) return;
    const parameters = call.parameters && typeof call.parameters === "object" ? (call.parameters as Dict) : {};
    const func = functionToolsOf(this.#fncCtx)[name];
    if (!func) {
      this.#logger.error({ tool: name }, "ElevenLabs asked for a tool the session does not have");
      this.#sendToolResult(toolCallId, JSON.stringify({ error: `unknown tool ${name}` }), true);
      return;
    }
    void Promise.resolve()
      .then(() => func.execute(parameters, { toolCallId, ctx: {} as any } as any))
      .then((result: unknown) => {
        const payload = typeof result === "string" ? result : JSON.stringify(result ?? null);
        this.#sendToolResult(toolCallId, payload, false);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#logger.error({ error: message, tool: name }, "ElevenLabs tool failed");
        this.#sendToolResult(toolCallId, JSON.stringify({ error: message }), true);
      });
  }

  #sendToolResult(toolCallId: string, result: string, isError: boolean): void {
    if (this.#completedToolCalls.has(toolCallId)) return;
    this.#completedToolCalls.add(toolCallId);
    this.#send({ type: "client_tool_result", tool_call_id: toolCallId, result, is_error: isError });
  }

  #onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.#ws) return;
    this.#ws = undefined;
    this.#stopFilling();
    this.#closeGeneration();
    if (this.#closing) return;
    this.#logger.warn({ code, reason, callId: this.#opts.callId }, "ElevenLabs conversation closed by the provider");
    (this.realtimeModel as ElevenLabsRealtimeModel)._notifyProviderEnded(this, { code, reason });
    this.#emitError(new Error(`ElevenLabs conversation closed (${code}${reason ? `: ${reason}` : ""})`), false);
  }

  #emitError(error: Error, recoverable: boolean): void {
    this.emit("error", {
      type: "realtime_model_error",
      timestamp: Date.now(),
      label: "elevenlabs-conversation",
      error,
      recoverable,
    } as llm.RealtimeModelError);
  }
}
