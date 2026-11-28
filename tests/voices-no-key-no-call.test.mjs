// With no key for a vendor, the server must not ask that vendor for its voice
// list: not when a team with a voice agent is stored or changed, and not when
// a voice list is read.
//
// The runtime settings stay (the made-up ones), so voice models are listed.
// Every vendor key is removed before lib/ loads. The catalogue stand-ins are
// switched off, so a request for a list would reach the guard
// (tests/setup/no-outside-network.cjs) and be logged as a refusal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'no-key-voices-'));
const refusalLog = path.join(scratch, 'refused.jsonl');

const VENDOR_SETTINGS = [
  'ULTRAVOX_API_KEY', 'ELEVENLABS_API_KEY', 'CARTESIA_API_KEY', 'NEUPHONIC_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_KEY', 'KIMI_KEY', 'OPENROUTER_KEY', 'TYPESAFE_API_KEY',
  'JAMBONZ_SERVER', 'JAMBONZ_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIAL', 'GOOGLE_APPLICATION_CREDENTIALS_JSON', 'K_SERVICE',
];
for (const name of VENDOR_SETTINGS) delete process.env[name];
process.env.TEST_VENDOR_STAND_INS = 'off';
process.env.TEST_NETWORK_LOG = refusalLog;

// A credential file of the kind `gcloud auth application-default login` leaves
// in the home folder. CLOUDSDK_CONFIG is where Google's library looks for it.
// Nobody configured it for this server, so it must not be used.
process.env.CLOUDSDK_CONFIG = path.join(scratch, 'gcloud');
fs.mkdirSync(process.env.CLOUDSDK_CONFIG, { recursive: true });
fs.writeFileSync(path.join(process.env.CLOUDSDK_CONFIG, 'application_default_credentials.json'), JSON.stringify({
  type: 'authorized_user',
  client_id: 'made-up.apps.googleusercontent.com',
  client_secret: 'made-up-secret',
  refresh_token: 'made-up-refresh-token',
}));

// Google's own client library here, not the test double: the double opens no
// connection, so it cannot show that Google is not asked.
const googleLibrary = path.resolve('node_modules/@google-cloud/text-to-speech/build/src/index.js');
jest.unstable_mockModule('@google-cloud/text-to-speech', () => import(googleLibrary));

const refusals = () => (fs.existsSync(refusalLog)
  ? fs.readFileSync(refusalLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []);

// Which vendor a refused connection was for. Google's gRPC client looks a name
// up by itself and connects by address, so its refusals are told by the stack.
const VENDORS = {
  ultravox: ({ host }) => /(^|\.)ultravox\.ai$/.test(host),
  elevenlabs: ({ host }) => /(^|\.)elevenlabs\.io$/.test(host),
  cartesia: ({ host }) => /(^|\.)cartesia\.ai$/.test(host),
  neuphonic: ({ host }) => /(^|\.)neuphonic\.com$/.test(host),
  xai: ({ host }) => /(^|\.)x\.ai$/.test(host),
  google: ({ host, stack }) => /google|^169\.254\./.test(host) || /grpc-js|google-auth-library|google-gax|gcp-metadata/.test(stack),
};

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
const makeRes = (user) => {
  const res = {
    locals: { user },
    statusCode: 200,
    status(code) { res.statusCode = code; return res; },
    send(body) { res.body = body; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
};

const REALTIME = ['livekit:openai/gpt-realtime', 'pipecat:openai/gpt-realtime'];
const PIPELINE = ['livekit:openai/gpt-4o-mini', 'pipecat:openai/gpt-4o-mini'];
const VENDOR_ROWS = [
  'livekit:ultravox/ultravox-v0.7', 'pipecat:ultravox/ultravox-v0.7',
  'livekit:elevenlabs/gpt-5.4-mini', 'pipecat:elevenlabs/gpt-5.4-mini',
];
const DEEPGRAM_VOICE = { vendor: 'deepgram', voice: 'aura-asteria-en' };

const agent = (label, modelName, tts) => ({
  label,
  name: label,
  modelName,
  prompt: 'You answer the phone.',
  options: { tts },
});

const team = () => ({
  name: 'Front desk',
  agents: [
    agent('reception', REALTIME[0], { voice: 'alloy' }),
    agent('sales', REALTIME[1], { voice: 'alloy' }),
    agent('support', PIPELINE[0], DEEPGRAM_VOICE),
    agent('nights', PIPELINE[1], DEEPGRAM_VOICE),
  ],
});

describe('with no vendor keys', () => {
  let db;
  let user;
  let createAgentSet;
  let updateAgentSet;
  const scenario = {};

  beforeAll(async () => {
    db = await import('./setup/database-test-wrapper.js');
    await db.setupRealDatabase();
    const organisation = await db.Organisation.create({ id: randomUUID(), name: 'No key voices' });
    const row = await db.User.create({
      id: randomUUID(), name: 'Tester', email: 'no-key-voices@test.example.com', emailVerified: true,
      phone: '+15550000000', phoneVerified: false, picture: '', role: 'owner', organisationId: organisation.id,
    });
    user = { id: row.id, organisationId: organisation.id, role: 'owner' };

    createAgentSet = (await import('../api/paths/agent-sets.js')).default(log).POST;
    updateAgentSet = (await import('../api/paths/agent-sets/{agentSetId}.js')).default(log).PUT;
    const { default: Voices } = await import('../lib/voices/index.js');
    // A vendor that is asked and never answers holds each list for this long.
    // Kept short, so that a failure here names the vendor and does not time out.
    Voices.vendorDeadlineMs = 500;
    const voices = new Voices(log);
    const voicesList = (await import('../api/paths/voices.js')).default(log, voices).GET;
    const locales = (await import('../api/paths/models/{modelName}/voices.js')).default(log, voices).GET;
    const byLocale = (await import('../api/paths/models/{modelName}/voices/{locale}.js')).default(log, voices).GET;
    const { searchModelVoices } = await import('../lib/model-voices.js');

    // Store a team with voice agents, then change it.
    scenario.created = makeRes(user);
    await createAgentSet({ body: team(), params: {}, query: {}, log }, scenario.created);
    scenario.updated = makeRes(user);
    const changed = team();
    changed.agents[0].prompt = 'You answer the phone, and you are brief.';
    await updateAgentSet({ body: changed, params: { agentSetId: scenario.created.body?.id }, query: {}, log }, scenario.updated);

    // Read the voice lists: the old one, each model's, and the builder's search.
    scenario.all = makeRes(user);
    await voicesList({ params: {}, query: {}, log }, scenario.all);
    scenario.byModel = {};
    for (const modelName of [...REALTIME, ...PIPELINE, ...VENDOR_ROWS]) {
      const localeList = makeRes(user);
      await locales({ params: { modelName: encodeURIComponent(modelName) }, query: {}, log }, localeList);
      const voiceList = makeRes(user);
      await byLocale({ params: { modelName: encodeURIComponent(modelName), locale: 'en-GB' }, query: {}, log }, voiceList);
      const search = await searchModelVoices({ modelName, terms: ['british'], voicesInstance: voices });
      scenario.byModel[modelName] = { locales: localeList, voices: voiceList, search };
    }
    scenario.refused = refusals();
  }, 120000);

  afterAll(async () => {
    await db.teardownRealDatabase();
    fs.rmSync(scratch, { recursive: true, force: true });
  }, 60000);

  test('a team with voice agents is stored and changed', () => {
    expect([scenario.created.statusCode, scenario.created.body?.agents?.length]).toEqual([200, 4]);
    expect(scenario.updated.statusCode).toBe(200);
  });

  test.each(Object.keys(VENDORS))('%s is not asked for its voice list', (vendor) => {
    const asked = scenario.refused.filter(VENDORS[vendor]).map(({ host, port }) => `${host}:${port}`);
    expect(asked).toEqual([]);
  });

  test('no connection to any other machine is opened', () => {
    expect(scenario.refused.map(({ host, port }) => `${host}:${port}`)).toEqual([]);
  });

  test('the lists hold the voices that need no vendor, and leave the others out', () => {
    const vendors = (tree) => Object.keys(tree).sort();
    expect(scenario.all.statusCode).toBe(200);
    // The Ultravox and Jambonz runtimes are off. On the two that are on, OpenAI,
    // xAI and Gemini Live (`google` on Pipecat) have built-in lists.
    expect(Object.fromEntries(Object.entries(scenario.all.body).map(([runtime, tree]) => [runtime, vendors(tree)])))
      .toEqual({ livekit: ['OpenAI', 'xAI'], pipecat: ['OpenAI', 'google', 'xAI'] });

    const listed = (modelName) => {
      const { locales, voices } = scenario.byModel[modelName];
      expect([modelName, locales.statusCode, voices.statusCode]).toEqual([modelName, 200, 200]);
      return vendors(voices.body.vendors);
    };
    // Deepgram's list is built in. It is offered on realtime rows as an external TTS.
    for (const modelName of REALTIME) expect([modelName, listed(modelName)]).toEqual([modelName, ['OpenAI', 'deepgram']]);
    for (const modelName of PIPELINE) expect([modelName, listed(modelName)]).toEqual([modelName, ['deepgram']]);
    expect(VENDOR_ROWS.map(listed)).toEqual([['deepgram'], ['deepgram'], [], []]);
    expect(scenario.byModel[REALTIME[0]].voices.body.vendors.OpenAI.map(({ name }) => name)).toContain('alloy');
  });

  test.each([
    ['ultravox', 'ULTRAVOX_API_KEY', 'livekit:ultravox/ultravox-v0.7', { voice: 'Ciara' }],
    ['ultravox', 'ULTRAVOX_API_KEY', 'pipecat:ultravox/ultravox-v0.7', { voice: 'Ciara' }],
    ['elevenlabs', 'ELEVENLABS_API_KEY', PIPELINE[0], { vendor: 'elevenlabs', voice: 'el-made-up-brit-0001' }],
    ['elevenlabs', 'ELEVENLABS_API_KEY', 'pipecat:elevenlabs/gpt-5.4-mini', { voice: 'el-made-up-brit-0001' }],
    ['cartesia', 'CARTESIA_API_KEY', PIPELINE[1], { vendor: 'cartesia', voice: 'made-up-cartesia-voice' }],
    ['neuphonic', 'NEUPHONIC_API_KEY', PIPELINE[1], { vendor: 'neuphonic', voice: 'made-up-neuphonic-voice' }],
    ['google', 'GOOGLE_APPLICATION_CREDENTIALS', PIPELINE[0], { vendor: 'google', voice: 'en-GB-Wavenet-A' }],
  ])('a voice from %s is refused with the reason (%s) and no request: %s', async (vendor, setting, modelName, tts) => {
    const before = refusals().length;
    const res = makeRes(user);
    await createAgentSet({ body: { name: 'One agent', agents: [agent('only', modelName, tts)] }, params: {}, query: {}, log }, res);
    expect([res.statusCode, res.body?.message]).toEqual([400,
      `Voice ${tts.voice} not supported by ${modelName}: this server has no voice list for ${vendor} (${setting} is not set)`]);
    expect(refusals().slice(before).map(({ host, port }) => `${host}:${port}`)).toEqual([]);
  });
});
