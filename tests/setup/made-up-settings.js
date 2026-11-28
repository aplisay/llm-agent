// The provider settings every test runs with, on every machine. global-setup.js
// applies them after it loads the environment, so a real value for one of these
// names never reaches a jest worker, and a machine with no keys lists the same
// models and voices as one with all of them. A setting that is not named here
// keeps the value the machine holds.
//
// None of these values works anywhere. `.invalid` names never resolve.
// tests/setup/vendor-stand-ins.js answers the catalogue requests that the
// keys switch on, and tests/setup/no-outside-network.cjs refuses the rest.

import os from 'node:os';
import path from 'node:path';

export const madeUpSettings = {
  // Model providers.
  OPENAI_API_KEY: 'made-up-openai-key',
  ANTHROPIC_API_KEY: 'made-up-anthropic-key',
  GOOGLE_API_KEY: 'made-up-google-key',
  ULTRAVOX_API_KEY: 'made-up-ultravox-key',
  XAI_API_KEY: 'made-up-xai-key',
  DEEPSEEK_KEY: 'made-up-deepseek-key',
  KIMI_KEY: 'made-up-kimi-key',
  OPENROUTER_KEY: 'made-up-openrouter-key',
  TYPESAFE_API_KEY: 'made-up-typesafe-key',
  // Speech providers.
  ELEVENLABS_API_KEY: 'made-up-elevenlabs-key',
  CARTESIA_API_KEY: 'made-up-cartesia-key',
  NEUPHONIC_API_KEY: 'made-up-neuphonic-key',
  // Runtimes. A handler lists its models only when all of its variables are set.
  LIVEKIT_URL: 'wss://livekit.invalid',
  LIVEKIT_API_KEY: 'made-up-livekit-key',
  LIVEKIT_API_SECRET: 'made-up-livekit-secret-0123456789abcdef',
  PIPECAT_WORKER_URL: 'http://pipecat-worker.invalid:8082',
  PIPECAT_DISPATCH_TOKEN: 'made-up-pipecat-dispatch-token',
  PIPECAT_JOIN_SECRET: 'made-up-pipecat-join-secret-0123456789abcdef',
  PIPECAT_PUBLIC_URL: 'https://pipecat.invalid',
  JAMBONZ_SERVER: 'https://jambonz.invalid',
  JAMBONZ_API_KEY: 'made-up-jambonz-key',
  // With a project named, a Google client does not ask the Google metadata
  // server for one. firebase-admin did, for each token that is not an API key.
  GOOGLE_CLOUD_PROJECT: 'made-up-project',
  // Names a file that does not exist. The server lists Google voices only with
  // credentials configured (the voice client is a test double), and a real
  // Google client that looks for credentials fails at once on this path.
  GOOGLE_APPLICATION_CREDENTIALS: path.join(os.tmpdir(), 'aplisay-test-no-such-google-credential.json'),
  // Unset, a machine that holds Google credentials records to a real bucket
  // (recordingStorageConfig in lib/recording/storage.js).
  RECORDING_STORAGE_PATH: `file://${path.join(os.tmpdir(), 'aplisay-test-recordings')}`,
};

// Removed, so that no Google client finds a real service account, and so that
// the older or optional forms of a setting do not differ between machines.
export const removedSettings = [
  'GOOGLE_CREDENTIAL',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GROK_API_KEY',
  'TYPESAFE_BASE_URL',
];

export function applyMadeUpSettings(env = process.env) {
  Object.assign(env, madeUpSettings);
  for (const name of removedSettings) delete env[name];
}
