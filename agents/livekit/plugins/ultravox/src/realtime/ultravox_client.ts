// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  UltravoxCallResponse,
  UltravoxModelData,
  UltravoxVoice,
  UltravoxVoicesResponse,
} from './api_proto.js';
import type { UltravoxCallMessage } from './user_turn_timings.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Voice id or name -> provider. A voice's provider does not change, so this lives for the process. */
const voiceProviders = new Map<string, string | undefined>();

export class UltravoxClient {
  private baseURL: string;
  private apiKey: string;
  constructor(apiKey: string, baseURL: string = 'https://api.ultravox.ai/api/',) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  async createCall(modelData: UltravoxModelData): Promise<UltravoxCallResponse> {
    const response = await fetch(`${this.baseURL}calls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      body: JSON.stringify(modelData),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to create Ultravox call: ${response.status} ${response.statusText} - ${body}\n${JSON.stringify(modelData)}`);
    }

    return response.json();
  }

  async deleteCall(callId: string): Promise<void> {
    const response = await fetch(`${this.baseURL}calls/${callId}`, {
      method: 'DELETE',
      headers: {
        'X-API-Key': this.apiKey,
      },
    });
  
  }

  /** When the call was joined, or undefined while it has not been. */
  async getCallJoined(callId: string, signal?: AbortSignal): Promise<string | undefined> {
    const response = await fetch(`${this.baseURL}calls/${callId}`, {
      headers: { 'X-API-Key': this.apiKey },
      signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to get Ultravox call: ${response.status} ${response.statusText}`);
    }
    const { joined } = (await response.json()) as { joined?: string | null };
    return joined ?? undefined;
  }

  /** Every in-call message of a call, following the result pages. */
  async listCallMessages(callId: string, signal?: AbortSignal): Promise<UltravoxCallMessage[]> {
    const messages: UltravoxCallMessage[] = [];
    let url: string | null = `${this.baseURL}calls/${callId}/messages?mode=in_call&pageSize=200`;
    for (let page = 0; url && page < 20; page++) {
      const response: Response = await fetch(url, { headers: { 'X-API-Key': this.apiKey }, signal });
      if (!response.ok) {
        throw new Error(`Failed to list Ultravox call messages: ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as { results?: UltravoxCallMessage[]; next?: string | null };
      messages.push(...(body.results ?? []));
      url = body.next ? new URL(body.next, this.baseURL).toString() : null;
    }
    return messages;
  }

  async getVoices(): Promise<UltravoxVoicesResponse> {
    const response = await fetch(`${this.baseURL}voices`, {
      method: 'GET',
      headers: {
        'X-API-Key': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get Ultravox voices: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * The TTS provider behind a voice given by id or name (the `voice` field of a
   * call accepts either). Undefined when the voice is not found.
   */
  async voiceProvider(voice: string): Promise<string | undefined> {
    if (voiceProviders.has(voice)) return voiceProviders.get(voice);
    const headers = { 'X-API-Key': this.apiKey };
    let found: UltravoxVoice | undefined;
    if (UUID_RE.test(voice)) {
      const response = await fetch(`${this.baseURL}voices/${voice}`, { headers });
      if (response.ok) found = await response.json();
      else if (response.status !== 404) {
        throw new Error(`Failed to get Ultravox voice: ${response.status} ${response.statusText}`);
      }
    } else {
      const url = `${this.baseURL}voices?search=${encodeURIComponent(voice)}&pageSize=100`;
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to search Ultravox voices: ${response.status} ${response.statusText}`);
      }
      const { results = [] } = (await response.json()) as UltravoxVoicesResponse;
      const wanted = voice.toLowerCase();
      found = results.find((v) => v.name?.toLowerCase() === wanted);
    }
    const provider = found?.provider || undefined;
    voiceProviders.set(voice, provider);
    return provider;
  }
}
