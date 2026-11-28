// What the server needs before it asks a vendor for its voice list
// (lib/voices/list-needs.js), and what a refused voice is told about a list
// that is not read. tests/voices-no-key-no-call.test.mjs checks that no
// request goes out when a need is unmet.
import { VOICE_LIST_NEEDS, voiceListMissing } from '../lib/voices/list-needs.js';
import { googleCredentialsConfigured } from '../lib/google-credential.js';
import { unreadVoiceListsNote } from '../lib/model-voices.js';

const ALL_SET = {
  ULTRAVOX_API_KEY: 'x', ELEVENLABS_API_KEY: 'x', CARTESIA_API_KEY: 'x', NEUPHONIC_API_KEY: 'x',
  GOOGLE_APPLICATION_CREDENTIALS: '/made-up/credential.json',
};

describe('what a vendor voice list needs', () => {
  test.each(Object.entries(VOICE_LIST_NEEDS))('%s: asked only with %s set', (vendor, needs) => {
    expect(voiceListMissing(vendor, {})).toEqual(needs);
    expect(voiceListMissing(vendor, { [needs[0]]: '' })).toEqual(needs);
    expect(voiceListMissing(vendor, ALL_SET)).toEqual([]);
  });

  test('a vendor with a built-in list needs nothing', () => {
    for (const vendor of ['deepgram', 'xai', 'openai']) expect(voiceListMissing(vendor, {})).toEqual([]);
  });

  test('Google: a named credential file or Cloud Run counts, and nothing else', () => {
    expect(googleCredentialsConfigured({})).toBe(false);
    expect(googleCredentialsConfigured({ GOOGLE_APPLICATION_CREDENTIALS: 'credentials/google.json' })).toBe(true);
    expect(googleCredentialsConfigured({ K_SERVICE: 'llm-agent' })).toBe(true);
    // The credential itself with no path to write it to: no Google client would find it.
    expect(googleCredentialsConfigured({ GOOGLE_CREDENTIAL: '{}', GOOGLE_APPLICATION_CREDENTIALS_JSON: '{}' })).toBe(false);
    // Set on a developer machine or by other tools. They do not configure this server.
    expect(googleCredentialsConfigured({ CLOUDSDK_CONFIG: '/home/someone/.config/gcloud', GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_API_KEY: 'k' })).toBe(false);
    expect(voiceListMissing('google', { K_SERVICE: 'llm-agent' })).toEqual([]);
  });
});

describe('Google voices', () => {
  const saved = { ...process.env };
  let Google;
  let resetGoogleVoicesCache;
  const log = { child: () => log, debug() {}, error() {}, warn() {} };

  beforeAll(async () => {
    ({ default: Google, resetGoogleVoicesCache } = await import('../lib/voices/google.js'));
  });
  afterEach(() => {
    for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'K_SERVICE']) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
    resetGoogleVoicesCache();
  });

  const listWith = async (env) => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.K_SERVICE;
    Object.assign(process.env, env);
    resetGoogleVoicesCache();
    return Object.keys(await new Google(log).listVoices('en-GB'));
  };

  test('are listed with a credential file named, and on Cloud Run', async () => {
    expect(await listWith({ GOOGLE_APPLICATION_CREDENTIALS: '/made-up/credential.json' })).toEqual(['en-GB']);
    expect(await listWith({ K_SERVICE: 'llm-agent' })).toEqual(['en-GB']);
  });

  test('are absent with neither', async () => {
    expect(await listWith({})).toEqual([]);
  });
});

describe('what a refused voice is told', () => {
  const note = (modelName, extra = {}) => unreadVoiceListsNote({ modelName, env: {}, ...extra });
  const no = (vendor, setting) => `${vendor} (${setting} is not set)`;

  test('a model that speaks with its own voice: its own list, when that list is fetched', () => {
    for (const modelName of ['livekit:ultravox/ultravox-v0.7', 'pipecat:ultravox/ultravox-v0.7', 'ultravox:ultravox/ultravox-v0.7']) {
      expect(note(modelName)).toBe(`: this server has no voice list for ${no('ultravox', 'ULTRAVOX_API_KEY')}`);
    }
    expect(note('pipecat:elevenlabs/gpt-5.4-mini')).toBe(`: this server has no voice list for ${no('elevenlabs', 'ELEVENLABS_API_KEY')}`);
    // OpenAI Realtime, Gemini Live and xAI have built-in lists. Gemini Live's
    // vendor key is `google`, which is not the Google text-to-speech list.
    for (const modelName of ['livekit:openai/gpt-realtime', 'pipecat:google/gemini-2.0-flash-exp', 'pipecat:xai/grok-voice']) {
      expect(note(modelName)).toBe('');
    }
  });

  test('a model that speaks through a TTS: each TTS list that is not read', () => {
    expect(note('livekit:openai/gpt-4o-mini')).toBe(': this server has no voice list for '
      + [no('google', 'GOOGLE_APPLICATION_CREDENTIALS'), no('elevenlabs', 'ELEVENLABS_API_KEY'),
        no('neuphonic', 'NEUPHONIC_API_KEY'), no('cartesia', 'CARTESIA_API_KEY')].join(', '));
    // The Pipecat worker has no Google TTS.
    expect(note('pipecat:openai/gpt-4o-mini')).not.toContain('google');
    // An external TTS on a realtime row, and a fallback announcement, are checked against the TTS lists.
    expect(note('pipecat:ultravox/ultravox-v0.7', { discreteTts: true, vendor: 'cartesia' }))
      .toBe(`: this server has no voice list for ${no('cartesia', 'CARTESIA_API_KEY')}`);
  });

  test('a named vendor narrows it, and a vendor with a built-in list has nothing to add', () => {
    expect(note('livekit:openai/gpt-4o-mini', { vendor: 'ElevenLabs' })).toBe(`: this server has no voice list for ${no('elevenlabs', 'ELEVENLABS_API_KEY')}`);
    expect(note('livekit:openai/gpt-4o-mini', { vendor: 'deepgram' })).toBe('');
  });

  test('nothing to add when the lists are read', () => {
    for (const modelName of ['livekit:ultravox/ultravox-v0.7', 'livekit:openai/gpt-4o-mini', 'jambonz:openai/gpt-4o']) {
      expect(unreadVoiceListsNote({ modelName, env: ALL_SET })).toBe('');
    }
    expect(unreadVoiceListsNote({ modelName: 'not a model name', env: {} })).toBe('');
  });
});
