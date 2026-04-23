import logger from "./logger.js";

// Error types used by the LiveKit worker to decide how to signal failures.
// Keep these provider-agnostic so they can be interpreted at higher layers.
export class ApiRequestError extends Error {
  status: number;
  body: any;
  code?: string;
  scope?: string;
  details?: any;

  constructor(status: number, body: any, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
    this.code = body?.code;
    this.scope = body?.scope;
    this.details = body?.details;
  }
}

// Busy-oriented error thrown by call.start() when the agent concurrency limit is exceeded.
// LiveKit uses the thrown error message to map to an intended SIP "busy" cause.
export class AgentConcurrencyLimitExceededBusyError extends Error {
  code = 'AGENT_CONCURRENCY_LIMIT_EXCEEDED';
  status = 429;
  scope?: string;
  details?: any;

  constructor(opts: { scope?: string; details?: any; originalError?: string } = {}) {
    const scopeSuffix = opts.scope ? ` [${opts.scope}]` : '';
    const original = opts.originalError ? ` - ${opts.originalError}` : '';
    super(`busy: AGENT_CONCURRENCY_LIMIT_EXCEEDED${scopeSuffix}${original}`);
    this.name = 'AgentConcurrencyLimitExceededBusyError';
    this.scope = opts.scope;
    this.details = opts.details;
  }
}

// API-related type definitions
export interface Instance {
  id: string;
  metadata?: Record<string, any>;
  Agent?: Agent;
  streamLog?: boolean;
  recording?: {
    enabled: boolean;
    key?: string;
  };
}

export interface Agent {
  id: string;
  userId: string;
  modelName: string;
  organisationId: string;
  prompt?: string;
  options?: {
    /**
     * Optional opening greeting played right after the session starts.
     *
     * Note: for Ultravox realtime, prefer `vendorSpecific.ultravox.firstSpeakerSettings` for
     * provider-native greetings; this block is intended to be portable and primarily used
     * for pipeline and OpenAI realtime sessions.
     */
    greeting?: {
      /**
       * Fixed greeting text.
       * When set, the agent plays this exact line at session start (uninterruptible) and waits for playout.
       */
      text?: string;
      /**
       * LLM instructions for the greeting.
       * When set (and `text` is not set), the agent asks the model to greet the user accordingly.
       */
      instructions?: string;
    };
    /**
     * Optional override for LiveKit voice stack. When omitted, mode is derived from the
     * model id in `modelName` (see GET /models: `voiceStack` / `requiresSttTts`).
     */
    voiceMode?: 'realtime' | 'pipeline';
    /**
     * Optional maximum session duration for realtime LLMs (e.g. "305s").
     * Used by worker when constructing RealtimeModel.
     */
    maxDuration?: string;
    /** Sampling temperature for pipeline LLM (OpenAI / Google plugins). */
    temperature?: number;
    stt?: {
      /**
       * BCP-47 primary tag (e.g. `en`) for pipeline Inference STT.
       * Values like `any` / `multi` are treated as unspecified and default to `en` (or `LIVEKIT_PIPELINE_STT_LANG`).
       */
      language?: string;
      /**
       * STT vendor for LiveKit pipeline (e.g. `deepgram`, `assemblyai`, `cartesia`).
       * You may optionally scope the inference model (and language suffix) via `vendor/model[:lang]`,
       * e.g. `deepgram/nova-3:en` (defaults to language derived from `stt.language`).
       */
      vendor?: string;
    };
    tts?: {
      language?: string;
      /**
       * TTS vendor for LiveKit pipeline (e.g. cartesia, google, elevenlabs).
       * `google` uses Gemini TTS on Node (`@livekit/agents-plugin-google`), not Google Cloud
       * voice ids (`en-GB-Standard-O`). Map timbre with `LIVEKIT_PIPELINE_GEMINI_TTS_VOICE`
       * (global), `LIVEKIT_PIPELINE_GEMINI_TTS_VOICE_<LANG>_<REGION>` (e.g. `..._EN_GB`),
       * or `vendorSpecific.google.geminiVoiceName`. For a custom Inference TTS string, set
       * `LIVEKIT_PIPELINE_GOOGLE_TTS`.
       *
       * You may optionally scope the inference model via `vendor/model`, e.g. `deepgram/aura-2`
       * or `cartesia/sonic-3`. If you include a full `vendor/model:voice` string here, it wins.
       */
      vendor?: string;
      voice?: string;
    };
    /**
     * Optional regular expression pattern to filter outbound calls.
     * The regexp is anchored with ^ and $ to match the complete phone number.
     * Only outbound calls (via originate or transfer) where the destination number matches this pattern will be allowed.
     */
    outboundCallFilter?: string;
    /**
     * Custom prompt to be used by the TransferAgent during consultative transfers.
     * This allows customization of how the TransferAgent introduces the call and interacts with the transfer target.
     * The prompt can include the placeholder ${parentTranscript} which will be replaced with the conversation history.
     * If not specified, a default prompt will be used.
     * This can be overridden on a per-transfer basis by providing transferPrompt as a parameter to the transfer function call.
     */
    transferPrompt?: string;
    /**
     * Fallback configuration for this agent. Used by the LiveKit worker to decide
     * how to recover when the primary model fails to connect or run.
     *
     * Precedence:
     *  1. agent  - restart with a different agent (not yet implemented in worker).
     *  2. model  - restart the session with a different modelName.
     *  3. number - transfer the call to this number using the builtin transfer function.
     */
    fallback?: {
      /**
       * Identifier of an alternative agent to use if the primary agent fails.
       */
      agent?: string;
      /**
       * Fallback model name to use if the primary model fails.
       */
      model?: string;
      /**
       * Fallback transfer destination (phone number or endpoint ID).
       */
      number?: string;
    };
    /**
     * Vendor-specific options for different providers.
     * Each vendor can have its own set of options that are passed through to the provider.
     */
    vendorSpecific?: {
      /**
       * Ultravox-specific options.
       * These options are passed directly to the Ultravox API when creating calls.
       */
      ultravox?: {
        /**
         * Experimental settings for Ultravox calls.
         * Example: { transcriptionProvider: "deepgram-nova-3" } or { transcriptionProvider: "ultravox" }
         */
        experimentalSettings?: {
          transcriptionProvider?: string;
          [key: string]: any;
        };
        /**
         * VAD settings forwarded to Ultravox `POST /api/calls` (`vadSettings`).
         * Durations use protobuf duration strings, e.g. `"0.384s"`.
         * @see https://docs.ultravox.ai/api-reference/calls/calls-post
         */
        vadSettings?: {
          turnEndpointDelay?: string;
          minimumTurnDuration?: string;
          minimumInterruptionDuration?: string;
          frameActivationThreshold?: number;
        };
        /**
         * Opening-turn behaviour (`firstSpeakerSettings`). Prefer this over the model-level
         * deprecated `firstSpeaker` enum; when set here, that enum is not sent on the create-call body.
         * Exactly one of `user` or `agent` should be set per Ultravox API.
         * @see https://docs.ultravox.ai/api-reference/calls/calls-post
         */
        firstSpeakerSettings?: {
          user?: {
            fallback?: {
              delay?: string;
              text?: string;
              prompt?: string;
            };
          };
          agent?: {
            uninterruptible?: boolean;
            text?: string;
            prompt?: string;
            delay?: string;
          };
        };
        /**
         * Messages spoken after cumulative periods of user inactivity (`inactivityMessages`).
         * Durations are protobuf-style strings (e.g. `"30s"`). See Ultravox docs for ordering and `endBehavior`.
         * @see https://docs.ultravox.ai/api-reference/calls/overview#inactivitymessages-5
         */
        inactivityMessages?: Array<{
          duration: string;
          message: string;
          endBehavior?:
            | 'END_BEHAVIOR_UNSPECIFIED'
            | 'END_BEHAVIOR_HANG_UP_SOFT'
            | 'END_BEHAVIOR_HANG_UP_STRICT';
        }>;
        [key: string]: any;
      };
      /**
       * Google / Gemini options for the LiveKit pipeline when using Gemini TTS.
       */
      google?: {
        /**
         * Prebuilt Gemini TTS voice name (e.g. Kore, Puck). Overrides env and Cloud-id defaults.
         */
        geminiVoiceName?: string;
      };
      [key: string]: any;
    };
    /**
     * Recording configuration for this agent.
     * Can be overridden at instance/listener level.
     */
    recording?: {
      enabled: boolean;
      key?: string;
    };
  };
  functions?: AgentFunction[];
  keys?: string[];
}

/**
 * Fetch an agent definition by ID from the main API.
 * Note: this is distinct from the /agent-db/* internal APIs used for calls.
 */
export async function getAgentById(agentId: string): Promise<Agent> {
  return makeApiRequest<Agent>(`/api/agents/${encodeURIComponent(agentId)}`);
}

export interface AgentFunction {
  name: string;
  description: string;
  input_schema: {
    properties: Record<string, {
      type: string;
      required?: boolean;
      [key: string]: any;
    }>;
  };
}

export interface Call {
  id: string;
  parentId?: string;
  userId: string;
  organisationId: string;
  instanceId: string;
  agentId: string;
  platform: string;
  platformCallId?: string;
  calledId?: string;
  callerId?: string;
  modelName?: string;
  options?: any;
  metadata?: {
    aplisay?: {
      callerId?: string;
      calledId?: string;
      fallbackNumbers?: string[];
      model?: string;
      callId?: string;
      [key: string]: any;
    };
    [key: string]: any;
  };
  start(): Promise<void>;
  end(reason?: string): Promise<void>;
}

export interface CallMetadata {
  [key: string]: any;
}

export interface OutboundInfo {
  toNumber: string;
  fromNumber: string;
  aplisayId: string;
  instanceId: string;
}

export interface TrunkInfo {
  id: string;
  name?: string | null;
  outbound: boolean;
  flags?: {
    canRefer?: boolean;
    [key: string]: any;
  } | null;
}

export interface PhoneNumberInfo {
  number: string;
  handler: string;
  instanceId?: string | null;
  organisationId?: string | null;
  outbound?: boolean;
  aplisayId?: string | null;
  trunk?: TrunkInfo | null;
  provisioned?: boolean;
  [key: string]: any;
}

export interface PhoneRegistrationInfo {
  id: string;
  name?: string | null;
  handler: string;
  status?: string;
  state?: string;
  outbound?: boolean;
  organisationId?: string | null;
  instanceId?: string | null;
  registrar?: string | null;
  options?: {
    transport?: string;
    [key: string]: any;
  } | null;
  [key: string]: any;
}

export type PhoneEndpointInfo = PhoneNumberInfo | PhoneRegistrationInfo;

export interface InvocationLogPayload {
  userId: string;
  organisationId: string;
  callId: string;
  subsystem?: string;
  log: any;
}

// Get the API base URL from environment variable
function getApiBaseUrl(): string {
  const serviceBaseUri = process.env.SERVICE_BASE_URI;
  
  if (!serviceBaseUri) {
    throw new Error('SERVICE_BASE_URI environment variable is required');
  }
  
  return serviceBaseUri;
}

// Make an HTTP request to the API
async function makeApiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}${endpoint}`;
  const sharedToken = process.env.SHARED_API_TOKEN;
  
  //logger.debug({ url, method: options.method || 'GET' }, 'Making API request');
  
  try {
    logger.debug({ url, method: options.method || 'GET', options }, 'Making API request');
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(sharedToken && { 'x-shared-token': sharedToken }),
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        {
          url,
          status: response.status,
          statusText: response.statusText,
          error: errorText,
        },
        'API request failed',
      );

      let body: any = null;
      try {
        body = JSON.parse(errorText);
      } catch {
        // If we can't parse JSON, keep a minimal structure.
        body = { raw: errorText };
      }

      throw new ApiRequestError(
        response.status,
        body,
        `API request failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    //logger.debug({ url, status: response.status }, 'API request successful');
    return data;
  } catch (error) {
    logger.error({ url, error }, 'API request error');
    throw error;
  }
}

// Get instance by ID from the API
export async function getInstanceById(instanceId: string): Promise<any> {
  return makeApiRequest(`/api/agent-db/instance?instanceId=${instanceId}`);
}

// Get instance by phone number from the API
export async function getInstanceByNumber(number: string): Promise<any> {
  return makeApiRequest(`/api/agent-db/instance?number=${encodeURIComponent(number)}`);
}

// Get phone numbers from the API
export async function getPhoneNumbers(handler?: string): Promise<any[]> {
  const query = handler ? `?handler=${encodeURIComponent(handler)}` : '';
  return makeApiRequest(`/api/agent-db/phone-numbers${query}`);
}

// Get phone endpoint by ID (PhoneRegistration)
export async function getPhoneEndpointById(id: string): Promise<PhoneRegistrationInfo | null> {
  try {
    const result = await makeApiRequest<{ items: PhoneRegistrationInfo[] }>(
      `/api/agent-db/phone-endpoints?id=${encodeURIComponent(id)}`
    );
    return result?.items?.[0] || null;
  } catch (error) {
    logger.error({ id, error }, 'Failed to get phone endpoint by id');
    return null;
  }
}

// Get phone endpoint by number (PhoneNumber)
// If trunkId is provided, validates that the call arrived on the correct trunk
export async function getPhoneEndpointByNumber(
  number: string,
  trunkId?: string | null
): Promise<PhoneNumberInfo | null> {
  try {
    let url = `/api/agent-db/phone-endpoints?number=${encodeURIComponent(number)}`;
    if (trunkId) {
      url += `&trunkId=${encodeURIComponent(trunkId)}`;
    }
    const result = await makeApiRequest<{ items: PhoneNumberInfo[] }>(url);
    return result?.items?.[0] || null;
  } catch (error: any) {
    // If it's a trunk mismatch error, re-throw it
    if (error?.message?.includes('Trunk mismatch')) {
      throw error;
    }
    logger.error({ number, trunkId, error }, 'Failed to get phone endpoint by number');
    return null;
  }
}

// Legacy function - kept for backward compatibility, now uses phone-endpoints endpoint
export async function getPhoneNumberByNumber(number: string): Promise<PhoneNumberInfo | null> {
  return getPhoneEndpointByNumber(number);
}

// Mark a phone number as provisioned (or not) in the platform after LiveKit sync
export async function setPhoneNumberProvisioned(
  number: string,
  provisioned: boolean
): Promise<void> {
  try {
    await makeApiRequest<{ success: boolean }>(
      `/api/agent-db/phone-endpoints/${encodeURIComponent(number)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ provisioned })
      }
    );
  } catch (error) {
    logger.error({ number, provisioned, error }, 'Failed to update phone number provisioning state');
  }
}


// Create a new call record
export async function createCall(callData: {
  id?: string;
  parentId?: string;
  userId: string;
  organisationId: string;
  instanceId: string;
  agentId: string;
  platform: string;
  platformCallId?: string;
  calledId?: string;
  callerId?: string;
  modelName?: string;
  options?: any;
  metadata?: any;
}): Promise<any> {
  const call = await makeApiRequest('/api/agent-db/call', {
    method: 'POST',
    body: JSON.stringify(callData)
  }) as any;
  
  // Add start() and end() methods to the call object
  call.start = async () => {
    logger.debug({ call }, "logging starting call");
    try {
      return await makeApiRequest(`/api/agent-db/call/${call.id}/start`, {
        method: 'POST',
        body: JSON.stringify({
          userId: call.userId,
          organisationId: call.organisationId
        })
      });
    } catch (err) {
      if (
        err instanceof ApiRequestError &&
        err.status === 429 &&
        err.code === 'AGENT_CONCURRENCY_LIMIT_EXCEEDED'
      ) {
        throw new AgentConcurrencyLimitExceededBusyError({
          scope: err.scope,
          details: err.details,
          originalError: err.body?.error ?? err.body?.raw,
        });
      }
      throw err;
    }
  };
  
  call.end = async (reason?: string, transactionLogs?: Array<{
    userId: string;
    organisationId: string;
    callId: string;
    type: string;
    data?: string;
    isFinal?: boolean;
    createdAt?: Date;
  }>) => {
    // Make this function idempotent - if already called, return the existing promise
    if ((call as any)._endCalled) {
      logger.debug({ callId: call.id, reason }, "call.end() already called, returning existing promise");
      return (call as any)._endPromise;
    }

    // Mark as called and store the promise
    (call as any)._endCalled = true;
    
    logger.debug({ call, reason, transactionLogCount: transactionLogs?.length }, "logging ending call");
    const body: any = { 
      reason,
      userId: call.userId,
      organisationId: call.organisationId
    };
    // Use provided transactionLogs, or fall back to batched logs on call object
    const logsToSend = transactionLogs || (call as any).batchedTransactionLogs;
    if (logsToSend && logsToSend.length > 0) {
      // Convert Date objects to ISO strings for JSON serialization
      body.transactionLogs = logsToSend.map((log: any) => ({
        ...log,
        createdAt: log.createdAt instanceof Date 
          ? log.createdAt.toISOString() 
          : log.createdAt ? new Date(log.createdAt).toISOString() : undefined
      }));
    }
    
    // Create and store the promise
    const endPromise = makeApiRequest(`/api/agent-db/call/${call.id}/end`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    
    (call as any)._endPromise = endPromise;
    
    // Handle errors to ensure the promise is still stored even on failure
    return endPromise.catch((error) => {
      logger.error({ callId: call.id, error }, "error in call.end(), but keeping promise for idempotency");
      throw error;
    });
  };
  
  return call;
}

export async function endCallById(callId: string, reason?: string): Promise<any> {
  return makeApiRequest(`/api/agent-db/call/${callId}/end`, {
    method: 'POST',
    body: JSON.stringify({ reason })
  });
}

export async function setCallRecordingData(
  callId: string,
  recordingId: string,
  encryptionKey?: string,
): Promise<void> {
  const body: any = { recordingId };
  if (encryptionKey) {
    body.encryptionKey = encryptionKey;
  }
  await makeApiRequest(`/api/agent-db/call/${encodeURIComponent(callId)}/recording`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// Create a new transaction log record
export async function createTransactionLog(transactionData: {
  userId: string;
  organisationId: string;
  callId: string;
  type: string;
  data?: string;
  isFinal?: boolean;
  createdAt?: Date;
}): Promise<any> {
  // we don't log status change events
  if (transactionData.type === 'status') {
    return null;
  }
  
  // Prepare the request body, converting Date to ISO string if present
  const requestBody: any = { ...transactionData };
  if (requestBody.createdAt instanceof Date) {
    requestBody.createdAt = requestBody.createdAt.toISOString();
  } else if (requestBody.createdAt) {
    // If it's already a string or other format, ensure it's a valid ISO string
    requestBody.createdAt = new Date(requestBody.createdAt).toISOString();
  }
  
  return makeApiRequest('/api/agent-db/transaction-log', {
    method: 'POST',
    body: JSON.stringify(requestBody)
  });
}

// Create a new invocation log record (compressed and stored server-side)
export async function saveInvocationLog(payload: InvocationLogPayload): Promise<any> {
  return makeApiRequest('/api/agent-db/invocation-log', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}



export { getApiBaseUrl, makeApiRequest };
