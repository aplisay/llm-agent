/**
 * Which runtimes and providers this instance can use, and why the rest are off.
 * Shown in the start-up log, by `yarn doctor` and by GET /api/health. It holds
 * variable names and booleans only, never a value.
 */
import { clearedPlaceholders } from './env-placeholders.js';

/**
 * A runtime is enabled when every variable its handler's `needKey` names is
 * set (Handler.availableModels gates the model list the same way).
 * tests/config-status.test.mjs checks these lists against the handlers.
 */
export const RUNTIMES = [
  { name: 'livekit', description: 'LiveKit worker: WebRTC and SIP', needs: ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_URL'] },
  { name: 'pipecat', description: 'Pipecat worker: SIP and WebRTC', needs: ['PIPECAT_WORKER_URL', 'PIPECAT_DISPATCH_TOKEN', 'PIPECAT_JOIN_SECRET', 'PIPECAT_PUBLIC_URL'] },
  { name: 'jambonz', description: 'External Jambonz cluster: SIP', needs: ['JAMBONZ_API_KEY', 'JAMBONZ_SERVER'] },
  { name: 'ultravox', description: 'Ultravox cloud: WebRTC, and SIP through Jambonz', needs: ['ULTRAVOX_API_KEY'] },
  { name: 'text', description: 'Text agents in the API server', needs: [] },
];

/** Read by the voice workers; the API sees only its own environment. */
export const SPEECH = [
  { name: 'deepgram', description: 'speech-to-text', needs: ['DEEPGRAM_API_KEY'] },
  { name: 'elevenlabs', description: 'text-to-speech, voice list', needs: ['ELEVENLABS_API_KEY'] },
  { name: 'cartesia', description: 'text-to-speech, voice list', needs: ['CARTESIA_API_KEY'] },
  { name: 'neuphonic', description: 'text-to-speech, voice list', needs: ['NEUPHONIC_API_KEY'] },
  { name: 'google', description: 'speech, Vertex AI, storage', needs: ['GOOGLE_APPLICATION_CREDENTIALS'] },
];

// Text model drivers. Each has a `needKey` and lists its rows only when it is set.
const PROVIDER_MODULES = ['openai', 'anthropic', 'gemini', 'xai', 'deepseek', 'kimi', 'openrouter', 'typesafe'];

const missingFrom = (names, env) => names.filter((name) => !env[name]);

async function providerStatus(env) {
  const rows = [];
  for (const file of PROVIDER_MODULES) {
    const { default: Model } = await import(`./models/${file}.js`);
    const { ok, need = [] } = Model.canLoad;
    rows.push({ name: file, enabled: ok, missing: ok ? [] : missingFrom(need, env) });
  }
  return rows;
}

export async function configStatus({ env = process.env } = {}) {
  const runtimes = RUNTIMES.map(({ name, description, needs }) => {
    const missing = missingFrom(needs, env);
    return { name, description, enabled: missing.length === 0, missing };
  });
  const providers = await providerStatus(env);
  const speech = SPEECH.map(({ name, description, needs }) => {
    const missing = missingFrom(needs, env);
    return { name, description, enabled: missing.length === 0, missing };
  });

  const warnings = [];
  const placeholders = clearedPlaceholders();
  if (placeholders.length) warnings.push(`ignored placeholder values (<...>) in ${placeholders.join(', ')}`);
  if (!env.CREDENTIALS_KEY) warnings.push('CREDENTIALS_KEY is unset: stored SIP passwords and agent keys are kept in plain text');
  if (!providers.some((p) => p.enabled) && !runtimes.find((r) => r.name === 'ultravox').enabled) {
    warnings.push('no model provider key is set: no agent can run');
  }
  if (env.APLISAY_STUB_MODEL === '1') {
    warnings.push('APLISAY_STUB_MODEL=1: the text:stub/echo test model is listed. Never set it in production');
  }
  if (env.SHARED_API_TOKEN && env.SHARED_API_TOKEN.startsWith('insecure-')) {
    warnings.push('SHARED_API_TOKEN is the development value from compose.yaml: run scripts/compose-setup.sh');
  }
  if (env.SHARED_API_TOKEN && env.SHARED_API_TOKEN.length < 24) {
    warnings.push('SHARED_API_TOKEN is short: it gives full access, so use a long random value');
  }
  return { runtimes, providers, speech, warnings };
}

/** Plain-text table for the start-up log and `yarn doctor`. */
export function formatStatus({ runtimes, providers, speech, warnings, extra = [] }) {
  const lines = [];
  const section = (title, rows) => {
    lines.push(title);
    for (const row of rows) {
      const state = row.enabled ? 'enabled' : 'disabled';
      const why = row.enabled ? '' : `  missing ${row.missing.join(', ')}`;
      lines.push(`  ${row.name.padEnd(11)} ${state.padEnd(9)}${why}`.trimEnd());
    }
  };
  section('Runtimes', runtimes);
  section('Model providers', providers);
  section('Speech providers (this process only; workers read their own)', speech);
  for (const [title, rows] of extra) section(title, rows);
  if (warnings.length) {
    lines.push('Warnings');
    for (const warning of warnings) lines.push(`  ${warning}`);
  }
  return lines.join('\n');
}
