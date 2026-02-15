import logger from '../agent-lib/logger.js';

// API-related type definitions
export interface Instance {
  id: string;
  metadata?: Record<string, any>;
  Agent?: Agent;
  streamLog?: boolean;
}

export interface Agent {
  id: string;
  userId: string;
  modelName: string;
  organisationId: string;
  prompt?: string;
  options?: {
    /**
     * Optional maximum session duration for realtime LLMs (e.g. "305s").
     * Used by worker when constructing RealtimeModel.
     */
    maxDuration?: string;
    tts?: {
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
        [key: string]: any;
      };
      [key: string]: any;
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
      logger.error({ 
        url, 
        status: response.status, 
        statusText: response.statusText, 
        error: errorText 
      }, 'API request failed');
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
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
    return makeApiRequest(`/api/agent-db/call/${call.id}/start`, {
      method: 'POST',
      body: JSON.stringify({
        userId: call.userId,
        organisationId: call.organisationId
      })
    });
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



export { getApiBaseUrl, makeApiRequest };
