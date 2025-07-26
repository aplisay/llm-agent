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
  multimodal,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as api_proto from './api_proto.js';
import { UltravoxClient } from './ultravox_client.js';

interface ModelOptions {
  modalities: ['text', 'audio'] | ['text'];
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
  type: 'message' | 'function_call';
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
    // Send audio frame to Ultravox WebSocket
    this.#session.sendAudioFrame(frame);
  }

  clear() {
    // Clear audio buffer - not needed for Ultravox
  }

  commit() {
    // Commit audio buffer - not needed for Ultravox
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
    this.#logger.debug({ itemId, contentIndex, audioEnd }, 'Truncate not supported in Ultravox');
  }

  delete(itemId: string) {
    // Not supported in Ultravox
    this.#logger.debug({ itemId }, 'Delete not supported in Ultravox');
  }

  create(message: llm.ChatMessage, previousItemId?: string): void {
    if (!message.content) {
      return;
    }

    // For Ultravox, we handle messages through the WebSocket
    // This method is mainly for compatibility
    this.#logger.debug('Conversation item created', { message, previousItemId });
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

export class RealtimeModel extends multimodal.RealtimeModel {
  sampleRate = api_proto.SAMPLE_RATE;
  numChannels = api_proto.NUM_CHANNELS;
  inFrameSize = api_proto.IN_FRAME_SIZE;
  outFrameSize = api_proto.OUT_FRAME_SIZE;

  #defaultOpts: ModelOptions;
  #sessions: RealtimeSession[] = [];
  #client: UltravoxClient;
  constructor({
    modalities = ['text', 'audio'],
    instructions = '',
    voice,
    inputAudioFormat = 'pcm16',
    outputAudioFormat = 'pcm16',
    temperature = 0.8,
    maxResponseOutputTokens = Infinity,
    model = 'fixie-ai/ultravox-70B',
    apiKey = process.env.ULTRAVOX_API_KEY || '',
    baseURL = 'https://api.ultravox.ai/api/',
    maxDuration = '305s',
    timeExceededMessage = 'It has been great chatting with you, but we have exceeded our time now.',
    transcriptOptional = false,
    firstSpeaker = 'FIRST_SPEAKER_AGENT',
  }: {
    modalities?: ['text', 'audio'] | ['text'];
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
    super();

    if (apiKey === '') {
      throw new Error(
        'Ultravox API key is required, either using the argument or by setting the ULTRAVOX_API_KEY environmental variable',
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

  session({
    fncCtx,
    chatCtx,
    modalities = this.#defaultOpts.modalities,
    instructions = this.#defaultOpts.instructions,
    voice = this.#defaultOpts.voice,
    inputAudioFormat = this.#defaultOpts.inputAudioFormat,
    outputAudioFormat = this.#defaultOpts.outputAudioFormat,
    temperature = this.#defaultOpts.temperature,
    maxResponseOutputTokens = this.#defaultOpts.maxResponseOutputTokens,
  }: {
    fncCtx?: llm.FunctionContext;
    chatCtx?: llm.ChatContext;
    modalities?: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice?: api_proto.Voice;
    inputAudioFormat?: api_proto.AudioFormat;
    outputAudioFormat?: api_proto.AudioFormat;
    temperature?: number;
    maxResponseOutputTokens?: number;
  }): RealtimeSession {
    const opts: ModelOptions = {
      modalities,
      instructions,
      voice,
      inputAudioFormat,
      outputAudioFormat,
      temperature,
      maxResponseOutputTokens,
      model: this.#defaultOpts.model,
      apiKey: this.#defaultOpts.apiKey,
      baseURL: this.#defaultOpts.baseURL,
      maxDuration: this.#defaultOpts.maxDuration,
      timeExceededMessage: this.#defaultOpts.timeExceededMessage,
      transcriptOptional: this.#defaultOpts.transcriptOptional,
      firstSpeaker: this.#defaultOpts.firstSpeaker,
    };

    const newSession = new RealtimeSession(opts, this.#client, {
      chatCtx: chatCtx || new llm.ChatContext(),
      fncCtx,
    });
    this.#sessions.push(newSession);
    return newSession;
  }

  async close() {
    await Promise.allSettled(this.#sessions.map((session) => session.close()));
  }
}

export class RealtimeSession extends multimodal.RealtimeSession {
  #chatCtx: llm.ChatContext | undefined = undefined;
  #fncCtx: llm.FunctionContext | undefined = undefined;
  #opts: ModelOptions;
  #client: UltravoxClient;
  #pendingResponses: { [id: string]: RealtimeResponse } = {};
  #sessionId = 'not-connected';
  #ws: WebSocket | null = null;
  #expiresAt: number | null = null;
  #logger = log();
  #task: Promise<void>;
  #closing = true;
  #sendQueue = new Queue<any>();
  #callId: string | null = null;
  #currentResponseId: string | null = null;
  #currentOutputIndex = 0;
  #currentContentIndex = 0;
  #audioStream?: AudioByteStream;

  constructor(
    opts: ModelOptions,
    client: UltravoxClient,
    { fncCtx, chatCtx }: { fncCtx?: llm.FunctionContext; chatCtx?: llm.ChatContext },
  ) {
    super();

    this.#opts = opts;
    this.#client = client;
    this.#fncCtx = fncCtx;
    this.#chatCtx = chatCtx;
    this.#task = this.#start();
  }

  get chatCtx(): llm.ChatContext | undefined {
    return this.#chatCtx;
  }

  get fncCtx(): llm.FunctionContext | undefined {
    return this.#fncCtx;
  }

  set fncCtx(ctx: llm.FunctionContext | undefined) {
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
      throw new Error('session not started');
    }
    return this.#expiresAt * 1000;
  }

  queueMsg(command: any): void {
    this.#sendQueue.put(command);
  }

  sendAudioFrame(frame: AudioFrame): void {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      const audioData = Buffer.from(frame.data.buffer);
      this.#ws.send(audioData);
    }
  }

  #getContent(
    ptr: ContentPtr = {
      response_id: this.#currentResponseId || '',
      output_index: this.#currentOutputIndex,
      content_index: this.#currentContentIndex,
    },
  ): { response?: RealtimeResponse; output?: RealtimeOutput; content?: RealtimeContent } {
    const response = this.#pendingResponses[ptr.response_id];
    const output = response?.output?.[ptr.output_index];
    const content = output?.content?.[ptr.content_index];
    this.#logger.debug('getContent', { ptr });
    return { response, output, content };
  }

  #generateEventId(): string {
    return `ultravox-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  #start(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        // Convert function context to Ultravox tools
        const selectedTools: api_proto.UltravoxTool[] = [];
        if (this.#fncCtx) {
          for (const [name, func] of Object.entries(this.#fncCtx)) {
            const tool: api_proto.UltravoxTool = {
              nameOverride: name,
              temporaryTool: {
                description: func.description,
                timeout: '30s',
                client: {},
                dynamicParameters: Object.entries(func.parameters.properties || {})
                  .filter(
                    ([, prop]) =>
                      (prop as any).source !== 'static' && (prop as any).source !== 'metadata',
                  )
                  .map(([propName, prop]) => ({
                    name: propName,
                    location: 'PARAMETER_LOCATION_BODY',
                    schema: {
                      type: (prop as any).type || 'string',
                      description: (prop as any).description || '',
                    },
                    required: (func.parameters.required || []).includes(propName),
                  })),
                // We dont send static parameters here, sort them out later in the client call
                staticParameters: [],
              },
            };
            selectedTools.push(tool);
          }
        }

        // Create Ultravox call
        const modelData: api_proto.UltravoxModelData = {
          model: this.#opts.model,
          maxDuration: this.#opts.maxDuration,
          timeExceededMessage: this.#opts.timeExceededMessage,
          systemPrompt: this.#opts.instructions,
          selectedTools,
          temperature: this.#opts.temperature,
          voice: this.#opts.voice,
          transcriptOptional: this.#opts.transcriptOptional,
          medium: {
            serverWebSocket: {
              inputSampleRate: 48000,
              outputSampleRate: 48000,
              clientBufferSizeMs: 60,
            },
          },
          firstSpeaker: this.#opts.firstSpeaker,
        };

        this.#logger.debug({ modelData }, 'Creating Ultravox call');
        const callResponse = await this.#client.createCall(modelData);
        this.#callId = callResponse.callId;

        if (callResponse.ended || !callResponse.callId || !callResponse.joinUrl) {
          throw new Error('Failed to create Ultravox call');
        }

        // Connect to Ultravox WebSocket
        const joinUrl = new URL(callResponse.joinUrl);
        joinUrl.searchParams.append('experimentalMessages', 'debug');

        this.#logger.debug('Connecting to Ultravox WebSocket at', joinUrl.toString());
        this.#ws = new WebSocket(joinUrl.toString());

        this.#ws.onerror = (error) => {
          reject(new Error('Ultravox WebSocket error: ' + error.message));
        };

        await once(this.#ws, 'open');
        this.#closing = false;
        this.#sessionId = this.#callId;
        this.#expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

        // Emit session created event (OpenAI format)
        this.emit('session_created', {
          event_id: this.#generateEventId(),
          type: 'session.created',
          session: {
            id: this.#sessionId,
            object: 'realtime.session',
            model: this.#opts.model,
            modalities: this.#opts.modalities,
            instructions: this.#opts.instructions,
            voice: this.#opts.voice || 'alloy',
            input_audio_format: this.#opts.inputAudioFormat,
            output_audio_format: this.#opts.outputAudioFormat,
            input_audio_transcription: null,
            turn_detection: null,
            tools: [],
            tool_choice: 'auto',
            temperature: this.#opts.temperature,
            max_response_output_tokens:
              this.#opts.maxResponseOutputTokens === Infinity
                ? 'inf'
                : this.#opts.maxResponseOutputTokens,
            expires_at: this.#expiresAt,
          },
        } as api_proto.Realtime_SessionCreatedEvent);

        this.#ws.onmessage = (message) => {
          if (message.data instanceof Buffer) {
            this.#handleAudio(message.data);
          } else {
            const event: api_proto.UltravoxMessage = JSON.parse(message.data as string);

            this.#handleMessage(event);
          }
        };

        const sendTask = async () => {
          while (this.#ws && !this.#closing && this.#ws.readyState === WebSocket.OPEN) {
            try {
              const event = await this.#sendQueue.get();
              this.#logger.debug(`-> ${JSON.stringify(event)}`);
              this.#ws.send(JSON.stringify(event));
            } catch (error) {
              this.#logger.error('Error sending event:', error);
            }
          }
        };

        sendTask();

        this.#ws.onclose = () => {
          if (this.#expiresAt && Date.now() >= this.#expiresAt) {
            this.#closing = true;
          }
          if (!this.#closing) {
            reject(new Error('Ultravox connection closed unexpectedly'));
          }
          this.#ws = null;
          resolve();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  async close() {
    this.#logger.info('closing call', { ws: this.#ws, call: this.#callId });
    if (!this.#ws) return;
    this.#closing = true;
    this.#ws.close();
    if (this.#callId) {
      try {
        await this.#client.deleteCall(this.#callId);
      } catch (error) {
        this.#logger.error('Error deleting call:', error);
      }
    }
    await this.#task;
  }

  #handleMessage(event: api_proto.UltravoxMessage): void {
    switch (event.type) {
      case 'state':
        this.#handleStatus(event);
        break;
      case 'transcript':
        this.#handleTranscript(event);
        break;
      case 'client_tool_invocation':
        this.#handleFunctionCall(event);
        break;
      case 'experimental_message':
        this.#handleExperimentalMessage(event);
        break;
      default:
        this.#logger.debug('Unknown message type:', (event as any).type);
    }
  }

  #handleStatus(event: api_proto.UltravoxStatusMessage): void {
    this.#logger.debug('Status:', event.state);

    // Map Ultravox status to OpenAI events
    if (event.state === 'listening') {
      this.#endResponse();
      // Emit input speech started
      this.emit('input_speech_started', {
        itemId: 'ultravox-user-input',
      } as InputSpeechStarted);
    } else if (event.state === 'thinking') {
    } else if (event.state === 'speaking') {
      // If we have just moved into the speaking state, we need to create a new response
      // and create a new audio byte stream for the response. If we are already in the speaking state,
      // then nothing needs to be done.
      if (!this.#currentResponseId) {
        this.#currentResponseId = this.#generateEventId();
        this.#logger.info('Creating new response', { responseId: this.#currentResponseId });
        // Create a new audio byte stream for the response
        this.#audioStream = new AudioByteStream(
          api_proto.SAMPLE_RATE,
          api_proto.NUM_CHANNELS,
          api_proto.OUT_FRAME_SIZE,
        );

        const response: RealtimeResponse = {
          id: this.#currentResponseId,
          status: 'in_progress',
          statusDetails: null,
          usage: null,
          output: [],
          doneFut: new Future(),
          createdTimestamp: Date.now(),
        };
        this.#pendingResponses[this.#currentResponseId] = response;

        // Emit response created event
        this.emit('response_created', response);

        // Emit response output added for audio content
        if (this.#currentResponseId) {
          const output: RealtimeOutput = {
            responseId: this.#currentResponseId,
            itemId: `output-${this.#currentOutputIndex}`,
            outputIndex: this.#currentOutputIndex,
            role: 'assistant',
            type: 'message',
            content: [],
            doneFut: new Future(),
          };

          const response = this.#pendingResponses[this.#currentResponseId];
          if (response) {
            response.output.push(output);
          }

          // Emit response output added event
          this.emit('response_output_added', output);

          // Add audio content
          const content: RealtimeContent = {
            responseId: this.#currentResponseId,
            itemId: output.itemId,
            outputIndex: this.#currentOutputIndex,
            contentIndex: this.#currentContentIndex,
            text: '',
            audio: [],
            textStream: new AsyncIterableQueue<string>(),
            audioStream: new AsyncIterableQueue<AudioFrame>(),
            toolCalls: [],
            contentType: 'audio',
          };

          output.content.push(content);
          response!.firstTokenTimestamp = Date.now();
          this.emit('response_content_added', content);
        }
      }
    }
  }

  #handleTranscript(event: api_proto.UltravoxTranscriptMessage): void {
    this.#logger.debug('handleTranscript', { event, responseId: this.#currentResponseId });
    const { output, content, response } = this.#getContent();
    if (event.role === 'user' && response) {
      // Emit input speech transcription completed
      if (event.final) {
        this.emit('input_speech_transcription_completed', {
          itemId: 'ultravox-user-transcript',
          transcript: event.text,
        } as InputSpeechTranscriptionCompleted);
      }
      // Emit input audio buffer committed
      this.emit('input_speech_committed', {
        itemId: 'ultravox-user-input',
      } as InputSpeechCommitted);
    } else if (event.role === 'agent' && response && content && output) {
      // Handle agent transcript - emit text delta events
      if (!event.final) {
        const transcript = event.delta;
        content.text += transcript;
        transcript && content.textStream.put(transcript);
      } else {
        content.text = event.text || '';
        content.textStream.close();
        this.#endResponse();
      }
    }
  }

  #endResponse() {
    const { content, output, response } = this.#getContent();
    if (!content || !output || !response) {
      return;
    }

    content.textStream.close();
    content.audioStream.close();

    // Emit audio done event
    this.emit('response_audio_done', content);
    // Emit text done event
    this.emit('response_text_done', content);
    // Emit content part done
    this.emit('response_content_done', content);
    // Emit output item done
    this.emit('response_output_done', output);
    // Emit response done
    this.emit('response_done', response);

    // Reset for next response
    this.#logger.info('Ending response', { responseId: this.#currentResponseId });
    this.#currentResponseId = null;
    this.#currentOutputIndex = 0;
    this.#currentContentIndex = 0;
  }

  #handleFunctionCall(event: api_proto.UltravoxFunctionCallMessage): void {
    this.#logger.debug('Function call received:', { event });

    if (!this.#fncCtx) {
      this.#logger.error('function call received but no fncCtx is available');
      return;
    }

    // parse the arguments and call the function inside the fnc_ctx
    const func = this.#fncCtx[event.toolName];
    if (!func) {
      this.#logger.error(`no function with name ${event.toolName} in fncCtx`);
      return;
    }
    this.emit('function_call_started', {
      callId: event.invocationId,
    });

    this.#logger.debug(
      `[Function Call ${event.invocationId}] Executing ${event.toolName} with arguments ${event.parameters}`,
    );

    // Create function call tool
    const toolCall: RealtimeToolCall = {
      name: event.toolName,
      arguments: event.parameters,
      toolCallID: event.invocationId,
    };

    // Emit function call arguments done event
    this.emit('response_function_call_arguments_done', toolCall);

    this.#executeFunction(toolCall).then(() => {
      this.emit('function_call_completed', {
        callId: toolCall.toolCallID,
      });
    });
  }

  async #executeFunction(toolCall: RealtimeToolCall): Promise<void> {
    if (!this.#fncCtx) {
      this.#logger.warn('No function context available');
      return;
    }

    const func = this.#fncCtx[toolCall.name];
    if (!func) {
      this.#logger.error(`No function with name ${toolCall.name} in function context`);
      return;
    }

    try {
      this.#logger.debug('Executing function:', toolCall.name);

      const result = await func.execute(toolCall.arguments);

      // Send function result back to Ultravox
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        const functionResult: api_proto.UltravoxFunctionResultMessage = {
          type: 'client_tool_result',
          invocationId: toolCall.toolCallID,
          result: JSON.stringify(result),
        };

        this.#logger.debug('Sending function result:', functionResult);
        this.#ws.send(JSON.stringify(functionResult));
      }
    } catch (error: unknown) {
      this.#logger.error(
        'Error executing function:',
        error instanceof Error ? error.message : String(error),
      );

      // Send error result back to Ultravox
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        const functionResult: api_proto.UltravoxFunctionResultMessage = {
          type: 'client_tool_result',
          invocationId: toolCall.toolCallID,
          errorType: 'implementation-error',
          errorMessage: error instanceof Error ? error.message : String(error),
        };

        this.#logger.debug('Sending function error result:', functionResult);
        this.#ws.send(JSON.stringify(functionResult));
      }
    }
  }

  #handleExperimentalMessage(event: api_proto.UltravoxExperimentalMessage): void {
    const message = event.message;
    if (message.type === 'debug' && message.message.startsWith('LLM response:')) {
      // Handle LLM response
      this.#logger.debug('LLM response:', message.message);
    }
  }

  async #handleAudio(audioData: Buffer): Promise<void> {
    if (!this.#currentResponseId) {
      this.#logger.info('No current response id, skipping audio', {
        currentResponseId: this.#currentResponseId,
      });
      return;
    }

    const { content } = this.#getContent();

    const frames = this.#audioStream?.write(audioData);
    frames &&
      frames.forEach((frame: AudioFrame) => {
        content?.audio.push(frame);
        content?.audioStream.put(frame);
      });
  }

  /** Create an empty audio message with the given duration. */
  #createEmptyUserAudioMessage(duration: number): llm.ChatMessage {
    const samples = duration * api_proto.SAMPLE_RATE;
    return new llm.ChatMessage({
      role: llm.ChatRole.USER,
      content: {
        frame: new AudioFrame(
          new Int16Array(samples * api_proto.NUM_CHANNELS),
          api_proto.SAMPLE_RATE,
          api_proto.NUM_CHANNELS,
          samples,
        ),
      },
    });
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
}
