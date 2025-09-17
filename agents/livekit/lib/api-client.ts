import logger from '../agent-lib/logger.js';

// API-related type definitions
export interface Instance {
  id: string;
  metadata?: Record<string, any>;
  Agent?: Agent;
}

export interface Agent {
  id: string;
  userId: string;
  modelName: string;
  organisationId: string;
  prompt?: string;
  options?: {
    tts?: {
      voice?: string;
    };
  };
  functions?: AgentFunction[];
  keys?: string[];
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
  end(): Promise<void>;
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

export interface PhoneNumberInfo {
  number: string;
  handler: string;
  instanceId?: string | null;
  organisationId?: string | null;
  outbound?: boolean;
  aplisayId?: string | null;
  [key: string]: any;
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

export async function getPhoneNumberByNumber(number: string): Promise<PhoneNumberInfo | null> {
  const results = await makeApiRequest<PhoneNumberInfo[]>(`/api/agent-db/phone-numbers?number=${encodeURIComponent(number)}`);
  return results?.[0] || null;
}

// Create a new call record
export async function createCall(callData: {
  id?: string;
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
    return makeApiRequest(`/api/agent-db/call/${call.id}/start`, {
      method: 'POST'
    });
  };
  
  call.end = async () => {
    return makeApiRequest(`/api/agent-db/call/${call.id}/end`, {
      method: 'POST'
    });
  };
  
  return call;
}

// Create a new transaction log record
export async function createTransactionLog(transactionData: {
  userId: string;
  organisationId: string;
  callId: string;
  type: string;
  data?: string;
  isFinal?: boolean;
}): Promise<any> {
  return makeApiRequest('/api/agent-db/transaction-log', {
    method: 'POST',
    body: JSON.stringify(transactionData)
  });
}



export { getApiBaseUrl, makeApiRequest };
