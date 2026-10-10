/**
 * POST /listener/{id}/join options.metadata reaches a LiveKit WebRTC call
 * through the agent dispatch in the participant token, sealed so the browser
 * holding the token cannot read it. The worker side of the merge is
 * agents/livekit/test/call-metadata.test.ts.
 */
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

const SECRET = 'test-livekit-api-secret-0123456789';
const KEY = 'APItestjoinmetadata';
const INSTANCE_ID = 'dc5e7c37-e644-45d3-80ec-12292dc1ea70';
const ENV = { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET, LIVEKIT_URL: 'wss://livekit.test' };
const savedEnv = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));
Object.assign(process.env, ENV);

// The handler module reads LIVEKIT_* when it loads. These stand-ins keep the
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
jest.unstable_mockModule('../lib/models/livekit.js', () => ({ default: class LiveKitModel {} }));
jest.unstable_mockModule('../lib/database.js', () => ({ Call: {} }));
jest.unstable_mockModule('../lib/concurrency/agent-concurrency-limits.js', () => ({
  AgentConcurrencyLimitExceededError: class extends Error {},
}));

const { default: Livekit } = await import('../lib/handlers/livekit.js');
const { openJoinMetadata } = await import('../lib/join-metadata.js');
const { TokenVerifier } = await import('livekit-server-sdk');

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** The agent dispatch metadata the worker receives as `ctx.job.metadata`. */
async function joinDispatch(joinArgs) {
  const handler = new Livekit({ instance: { id: INSTANCE_ID }, logger });
  const response = await handler.join(joinArgs);
  const claims = await new TokenVerifier(KEY, SECRET).verify(response.livekit.participantToken);
  return { raw: claims.roomConfig.agents[0].metadata, claims, response };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('LiveKit WebRTC join metadata', () => {
  const metadata = { simplyai: { agent_key: 'ak-123' }, crm: { tier: 'gold' } };

  test('options.metadata rides in the agent dispatch, sealed', async () => {
    const { raw } = await joinDispatch({ options: { metadata } });
    const dispatch = JSON.parse(raw);
    expect(dispatch).toEqual({
      identity: INSTANCE_ID,
      callId: expect.stringMatching(UUID),
      sealedCallMetadata: expect.stringMatching(/^v1\./),
    });
    expect(openJoinMetadata(dispatch.sealedCallMetadata, SECRET)).toEqual(metadata);
  });

  test('the token holder cannot read the metadata', async () => {
    const { raw, claims } = await joinDispatch({ options: { metadata } });
    for (const text of [raw, JSON.stringify(claims)]) {
      expect(text).not.toContain('ak-123');
      expect(text).not.toContain('agent_key');
    }
  });

  test('each join seals afresh', async () => {
    const first = JSON.parse((await joinDispatch({ options: { metadata } })).raw);
    const second = JSON.parse((await joinDispatch({ options: { metadata } })).raw);
    expect(first.sealedCallMetadata).not.toBe(second.sealedCallMetadata);
  });

  test.each([
    ['no arguments', undefined],
    ['no options', {}],
    ['no metadata', { options: {} }],
    ['empty metadata', { options: { metadata: {} } }],
    ['null options', { options: null }],
  ])('a join with %s dispatches no sealed metadata', async (_name, joinArgs) => {
    const { raw } = await joinDispatch(joinArgs);
    expect(JSON.parse(raw)).toEqual({ identity: INSTANCE_ID, callId: expect.stringMatching(UUID) });
  });

  test('a value sealed with another secret does not open', async () => {
    const { raw } = await joinDispatch({ options: { metadata } });
    expect(() => openJoinMetadata(JSON.parse(raw).sealedCallMetadata, 'another-secret-entirely')).toThrow();
  });
});

// LiveKit dispatches the token's agent only when the join creates the room, and
// a second participant with the same identity disconnects the first.
describe('LiveKit WebRTC join room', () => {
  test('each join gets its own room, identity and call id', async () => {
    const first = await joinDispatch();
    const second = await joinDispatch();
    expect(second.claims.video.room).not.toBe(first.claims.video.room);
    expect(second.claims.sub).not.toBe(first.claims.sub);
    expect(second.response.callId).not.toBe(first.response.callId);
  });

  test('the response, the token and the dispatch agree', async () => {
    const { raw, claims, response } = await joinDispatch();
    const { callId, livekit } = response;
    expect(callId).toMatch(UUID);
    expect(claims.video.room).toBe(`agent-${INSTANCE_ID}-${callId}`);
    expect(livekit.roomName).toBe(claims.video.room);
    expect(claims.sub).toBe(`webrtc-${callId}`);
    expect(livekit.participantName).toBe(claims.sub);
    expect(claims.metadata).toBe(INSTANCE_ID);
    expect(JSON.parse(raw)).toMatchObject({ identity: INSTANCE_ID, callId });
  });
});
