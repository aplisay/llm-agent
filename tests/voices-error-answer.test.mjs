/**
 * GET /voices answers a failed voice list with a message, not the caught error.
 * The handler roster is a stand-in whose voice list fails with an HTTP client
 * error that carries a made-up header.
 */
import { jest, describe, expect, test, beforeAll } from '@jest/globals';
import axios, { AxiosError } from 'axios';

const MADE_UP = 'made-up-value';

async function httpClientError() {
  const client = axios.create({
    baseURL: 'https://api.example.test/v1/',
    headers: { 'X-Example': MADE_UP },
    adapter: async (config) => {
      throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, {},
        { status: 403, data: {}, headers: {}, config });
    },
  });
  return client.get('/voices').catch((err) => err);
}

let failure;
jest.unstable_mockModule('../lib/handlers/index.js', () => ({
  default: async () => ({
    implementations: [{
      name: 'example',
      canLoad: { ok: true },
      get voices() { return Promise.reject(failure); },
    }],
  }),
}));

describe('GET /voices error answer', () => {
  let voicesList;
  const log = { error: jest.fn(), info() {}, debug() {}, warn() {} };

  beforeAll(async () => {
    failure = await httpClientError();
    voicesList = (await import('../api/paths/voices.js')).default(log, {}).GET;
  });

  const makeRes = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
  });

  test('answers 500 with a message only', async () => {
    const res = makeRes();
    await voicesList({ log }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain(MADE_UP);
    expect(log.error).toHaveBeenCalledWith(failure, 'getting voices');
  });

  test('a plain error gives the fixed message, not its own', async () => {
    failure = new Error("Cannot read properties of undefined (reading 'example')");
    const res = makeRes();
    await voicesList({ log }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: 'Internal server error' });
  });
});
