// What each vendor's catalogue endpoint answers in tests. Every body is in the
// vendor's own format and is made up: the real loaders and mappers in lib/ run
// on it. tests/setup/vendor-stand-ins.js serves these in place of the vendors.
//
// A test that saves an agent with a voice needs that voice here.
import { madeUpSettings } from '../setup/made-up-settings.js';
import { CARTESIA_PAGES } from './cartesia-voices.mjs';
import { NEUPHONIC_FIXTURE } from './neuphonic-voices.mjs';

const ultravoxVoice = (name, description, provider, over = {}) => ({
  voiceId: `made-up-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
  name,
  description,
  primaryLanguage: 'en-US',
  ownership: 'public',
  provider,
  ...over,
});

const elevenLabsVoice = (id, name, labels) => ({
  voice_id: id,
  name,
  category: 'premade',
  labels: { language: 'en', use_case: 'conversational', ...labels },
});

const googleVoice = (name, ssmlGender) => ({
  languageCodes: [name.split('-').slice(0, 2).join('-')],
  name,
  ssmlGender,
  naturalSampleRateHertz: 24000,
});

const jambonzAccount = 'made-up-account-sid';
const jambonzProvider = 'made-up-provider-sid';
const jambonzCredential = (vendor, ok = true) => ({
  speech_credential_sid: `made-up-${vendor}-credential-sid`,
  account_sid: jambonzAccount,
  vendor,
  use_for_tts: 1,
  use_for_stt: 1,
  tts_tested_ok: ok,
  stt_tested_ok: ok,
});
const jambonz = `${madeUpSettings.JAMBONZ_SERVER}/v1`;

/** GET url (without its query string) → JSON body. */
export const vendorCatalogues = {
  'https://api.ultravox.ai/api/voices': {
    next: null,
    previous: null,
    total: 6,
    results: [
      ultravoxVoice('Ciara', 'Warm Irish woman', 'Eleven Labs', { primaryLanguage: 'en-IE' }),
      ultravoxVoice('Raquel', 'Clear Spanish woman', 'Eleven Labs', { primaryLanguage: 'es-ES' }),
      ultravoxVoice('Mark', 'Energetic American man', 'Inworld'),
      ultravoxVoice('Svetlana', 'Calm woman', 'Cartesia'),
      ultravoxVoice('A made-up voice with a long name', '', 'Cartesia'),
      ultravoxVoice('Made-up clone', 'Voice cloned at 2026-10-02', 'Eleven Labs', { ownership: 'private' }),
    ],
  },

  'https://api.elevenlabs.io/v1/voices': {
    voices: [
      elevenLabsVoice('el-made-up-brit-0001', 'Dominus', { accent: 'british', age: 'middle_aged', gender: 'male', descriptive: 'deep' }),
      elevenLabsVoice('el-made-up-amer-0002', 'Rachel', { accent: 'american', age: 'young', gender: 'female', descriptive: 'calm' }),
      elevenLabsVoice('el-made-up-aust-0003', 'Bruce', { accent: 'australian', age: 'old', gender: 'male', descriptive: 'casual' }),
      elevenLabsVoice('el-made-up-york-0004', 'Hattie', { accent: 'yorkshire', age: 'young', gender: 'female', descriptive: 'bright' }),
    ],
    has_more: false,
    total_count: 4,
  },

  // The page fixtures of tests/cartesia-voices.test.mjs, as one page.
  'https://api.cartesia.ai/voices': {
    data: CARTESIA_PAGES.flatMap((page) => page.data),
    has_more: false,
    next_page: null,
  },

  'https://api.neuphonic.com/voices': NEUPHONIC_FIXTURE,

  'https://api.x.ai/v1/tts/voices': {
    voices: [
      { voice_id: 'ara', name: 'Ara', language: 'multilingual', gender: 'female' },
      { voice_id: 'eve', name: 'Eve', language: 'multilingual', gender: 'female' },
      { voice_id: 'leo', name: 'Leo', language: 'multilingual', gender: 'male' },
      { voice_id: 'rex', name: 'Rex', language: 'multilingual', gender: 'male' },
      { voice_id: 'sal', name: 'Sal', language: 'multilingual', gender: 'male' },
      { voice_id: 'liora', name: 'Liora', language: 'multilingual', gender: 'female' },
    ],
  },

  // The Jambonz handler lists the voices of each vendor whose credential has passed its TTS test.
  [`${jambonz}/ServiceProviders`]: [{ service_provider_sid: jambonzProvider, name: 'made-up provider' }],
  [`${jambonz}/Accounts`]: [{ account_sid: jambonzAccount, service_provider_sid: jambonzProvider, name: 'made-up account' }],
  [`${jambonz}/Accounts/${jambonzAccount}/SpeechCredentials`]: [
    jambonzCredential('google'),
    jambonzCredential('deepgram'),
    jambonzCredential('elevenlabs'),
    jambonzCredential('aws', false),
  ],
};

/** `voices` of a Google Cloud Text-to-Speech ListVoices response. */
export const googleTextToSpeechVoices = [
  googleVoice('en-GB-Wavenet-A', 'FEMALE'),
  googleVoice('en-GB-Wavenet-B', 'MALE'),
  googleVoice('en-US-Wavenet-D', 'MALE'),
  googleVoice('en-US-Neural2-F', 'FEMALE'),
  googleVoice('fr-FR-Wavenet-C', 'FEMALE'),
  googleVoice('de-DE-Wavenet-B', 'MALE'),
  // One voice can serve two locales.
  { ...googleVoice('cmn-CN-Wavenet-A', 'FEMALE'), languageCodes: ['cmn-CN', 'cmn-TW'] },
];
