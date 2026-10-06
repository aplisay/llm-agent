/**
 * POST /listener/{id}/join options.metadata reaches a Pipecat WebRTC call
 * through the join token in the offer URL, sealed so the browser holding the
 * token cannot read it. The worker side is
 * agents/pipecat/tests/test_join_metadata.py; the two implementations are
 * checked against each other in tests/join-metadata-cross-language.test.mjs.
 */
import { afterAll, describe, expect, jest, test } from '@jest/globals';
import crypto from 'node:crypto';

const SECRET = 'test-pipecat-join-secret-0123456789';
const INSTANCE_ID = 'dc5e7c37-e644-45d3-80ec-12292dc1ea70';
const ENV = { PIPECAT_JOIN_SECRET: SECRET, PIPECAT_PUBLIC_URL: 'https://pipecat.test/' };
const savedEnv = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));
Object.assign(process.env, ENV);

// The handler module reads PIPECAT_* when it loads. These stand-ins keep the
// load from fetching voice lists or opening the database.
jest.unstable_mockModule('../lib/handlers/handler.js', () => ({
  default: class Handler {
    constructor({ instance, logger }) {
      Object.assign(this, { instance, logger });
    }
  },
}));
jest.unstable_mockModule('../lib/handlers/ultravox.js', () => ({ default: { voices: Promise.resolve({}) } }));
jest.unstable_mockModule('../lib/models/xai.js', () => ({ default: { voices: Promise.resolve({}) } }));
jest.unstable_mockModule('../lib/models/pipecat.js', () => ({ default: class PipecatModel {} }));
jest.unstable_mockModule('../lib/database.js', () => ({ Call: {} }));
jest.unstable_mockModule('../lib/concurrency/agent-concurrency-limits.js', () => ({
  AgentConcurrencyLimitExceededError: class extends Error {},
}));

const { default: Pipecat } = await import('../lib/handlers/pipecat.js');
const { JOIN_METADATA_KEY_INFO, openJoinMetadata } = await import('../lib/join-metadata.js');

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Join, then check the token's signature the way the worker does and decode its payload. */
async function joinToken(joinArgs) {
  const handler = new Pipecat({ instance: { id: INSTANCE_ID }, logger });
  const { pipecat } = await handler.join(joinArgs);
  const [payloadB64, signature] = pipecat.token.split('.');
  const raw = Buffer.from(payloadB64, 'base64url').toString('utf8');
  expect(crypto.createHmac('sha256', SECRET).update(raw).digest('base64url')).toBe(signature);
  expect(new URL(pipecat.offerUrl).searchParams.get('token')).toBe(pipecat.token);
  return { pipecat, raw, payload: JSON.parse(raw) };
}

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('Pipecat WebRTC join metadata', () => {
  const metadata = { simplyai: { agent_key: 'ak-123' }, crm: { tier: 'gold' } };

  test('options.metadata rides in the join token, sealed', async () => {
    const { payload } = await joinToken({ options: { metadata } });
    expect(payload).toEqual({
      instanceId: INSTANCE_ID,
      sessionId: expect.stringMatching(new RegExp(`^join-${INSTANCE_ID}-\\d+$`)),
      expiresAt: expect.any(Number),
      sealedCallMetadata: expect.stringMatching(/^v1\./),
    });
    expect(openJoinMetadata(payload.sealedCallMetadata, SECRET, JOIN_METADATA_KEY_INFO.pipecat)).toEqual(metadata);
  });

  test('the token holder cannot read the metadata', async () => {
    const { pipecat, raw } = await joinToken({ options: { metadata } });
    for (const text of [raw, JSON.stringify(pipecat), decodeURIComponent(pipecat.offerUrl)]) {
      expect(text).not.toContain('ak-123');
      expect(text).not.toContain('agent_key');
    }
  });

  test('each join seals afresh', async () => {
    const first = (await joinToken({ options: { metadata } })).payload;
    const second = (await joinToken({ options: { metadata } })).payload;
    expect(first.sealedCallMetadata).not.toBe(second.sealedCallMetadata);
  });

  test.each([
    ['no arguments', undefined],
    ['no options', {}],
    ['no metadata', { options: {} }],
    ['empty metadata', { options: { metadata: {} } }],
    ['null options', { options: null }],
    ['array metadata', { options: { metadata: ['x'] } }],
  ])('a join with %s mints the token as before', async (_name, joinArgs) => {
    const { payload } = await joinToken(joinArgs);
    expect(Object.keys(payload).sort()).toEqual(['expiresAt', 'instanceId', 'sessionId']);
  });

  test('the key is not the LiveKit one, and another secret does not open it', async () => {
    const { payload } = await joinToken({ options: { metadata } });
    expect(() => openJoinMetadata(payload.sealedCallMetadata, SECRET, JOIN_METADATA_KEY_INFO.livekit)).toThrow();
    expect(() =>
      openJoinMetadata(payload.sealedCallMetadata, 'another-secret-entirely', JOIN_METADATA_KEY_INFO.pipecat),
    ).toThrow();
  });
});
