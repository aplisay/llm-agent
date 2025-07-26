// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  UltravoxCallResponse,
  UltravoxModelData,
  UltravoxVoicesResponse,
} from './api_proto.js';

export class UltravoxClient {
  private baseURL: string;
  private apiKey: string;

  constructor(apiKey: string, baseURL: string = 'https://api.ultravox.ai/api/') {
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
      throw new Error(`Failed to create Ultravox call: ${response.status} ${response.statusText}`);
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

    if (!response.ok) {
      throw new Error(`Failed to delete Ultravox call: ${response.status} ${response.statusText}`);
    }
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
}
