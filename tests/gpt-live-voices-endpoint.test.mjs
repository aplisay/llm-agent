import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';
import { OPENAI_LIVE_DEFAULT_VOICE, OPENAI_LIVE_VOICES } from '../lib/voices/openai-live.js';

/**
 * The voices endpoints on the GPT-Live row (docs/gpt-live.md):
 * `GET /models/{modelName}/voices` and `GET /models/{modelName}/voices/{locale}`
 * list the model-scoped GPT-Live voice set under the `OpenAI` vendor, at any
 * locale, and nothing else: no discrete TTS catalogue (the row has no
 * text-output mode) and none of the Realtime-only names the Live API rejects.
 * The OpenAI Realtime row keeps its own list plus the discrete catalogue. The
 * catalogue instance is a stub so no TTS vendor API is called; the handler's
 * own `voices` map is the real one.
 */

const mockLogger = {
  info: () => { }, warn: () => { }, error: () => { }, debug: () => { }, child: () => mockLogger,
};

// Stands in for lib/voices: the discrete TTS catalogue the pipeline rows use.
const mockVoices = {
  listVoices: async () => ({
    elevenlabs: { 'en-GB': [{ name: 'Rachel', description: 'Rachel' }] },
    deepgram: { 'en-US': [{ name: 'aura-asteria-en', description: 'Asteria' }] },
  }),
};

function makeReq(params) {
  return { params, query: {}, body: {}, log: mockLogger };
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
  };
}

const GPT_LIVE = 'pipecat:openai/gpt-live-1';
const REALTIME = 'pipecat:openai/gpt-realtime';

describe('GPT-Live voices endpoints', () => {
  let localesGet, voicesGet;

  beforeAll(async () => {
    await setupRealDatabase();
    localesGet = (await import('../api/paths/models/{modelName}/voices.js')).default(mockLogger, mockVoices).GET;
    voicesGet = (await import('../api/paths/models/{modelName}/voices/{locale}.js')).default(mockLogger, mockVoices).GET;
  }, 60000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  const locales = async (modelName) => {
    const res = makeRes();
    await localesGet(makeReq({ modelName }), res);
    return res;
  };
  const voices = async (modelName, locale) => {
    const res = makeRes();
    await voicesGet(makeReq({ modelName, locale }), res);
    return res;
  };

  test('the row offers the locale-neutral `any` locale as a realtime stack', async () => {
    const res = await locales(GPT_LIVE);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ locales: ['any'], voiceStack: 'realtime' });
  });

  test('lists the GPT-Live voice set under OpenAI and nothing else', async () => {
    const res = await voices(GPT_LIVE, 'any');
    expect(res.statusCode).toBe(200);
    expect(res.body.voiceStack).toBe('realtime');
    expect(Object.keys(res.body.vendors)).toEqual(['OpenAI']);
    const names = res.body.vendors.OpenAI.map((v) => v.name);
    expect(names).toEqual(OPENAI_LIVE_VOICES.map((v) => v.name));
    expect(names).toHaveLength(22);
    expect(names).toEqual(expect.arrayContaining(['marin', 'cedar', 'alloy']));
    expect(names).toContain(OPENAI_LIVE_DEFAULT_VOICE);
    // Realtime-only names the Live API rejects.
    expect(names).not.toEqual(expect.arrayContaining(['onyx']));
    expect(names).not.toContain('nova');
    expect(names).not.toContain('fable');
    for (const row of res.body.vendors.OpenAI) {
      expect(typeof row.name).toBe('string');
      expect(typeof row.description).toBe('string');
    }
  });

  test('any requested locale falls back to the `any` list', async () => {
    const gb = await voices(GPT_LIVE, 'en-GB');
    expect(gb.statusCode).toBe(200);
    expect(gb.body.vendors.OpenAI.map((v) => v.name)).toEqual(OPENAI_LIVE_VOICES.map((v) => v.name));
  });

  test('the OpenAI Realtime row keeps the Realtime list and the discrete catalogue', async () => {
    const res = await voices(REALTIME, 'any');
    expect(res.statusCode).toBe(200);
    const names = res.body.vendors.OpenAI.map((v) => v.name);
    expect(names).toContain('onyx');
    expect(names).not.toContain('marin');
    // The row is flagged externalTts, so at a real locale the pipeline TTS
    // catalogue is offered beside the model's own (locale-neutral) voices.
    const gb = await voices(REALTIME, 'en-GB');
    expect(Object.keys(gb.body.vendors).sort()).toEqual(['OpenAI', 'elevenlabs']);
    expect(gb.body.vendors.elevenlabs.map((v) => v.name)).toEqual(['Rachel']);
    // The GPT-Live row never offers the discrete catalogue.
    const gpt = await voices(GPT_LIVE, 'en-GB');
    expect(Object.keys(gpt.body.vendors)).toEqual(['OpenAI']);
  });

  test('rejects a model name without a handler and an unknown handler', async () => {
    const bad = await voices('nonsense', 'any');
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error).toMatch(/Invalid modelName/);
    const unknown = await locales('nosuchhandler:openai/gpt-live-1');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body.error).toMatch(/Unknown handler/);
  });
});
