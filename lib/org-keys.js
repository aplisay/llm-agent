/**
 * BYOK organisation-key resolution (docs/byok.md): the need-to-know filter for
 * an agent, and decryption of the stored keys for that filtered provider set.
 * Decryption happens ONLY here, in the main server process — workers receive
 * the resolved values inside the per-call agent-db document and never touch
 * the table or CREDENTIALS_KEY themselves.
 */
import { OrganisationKey } from './database.js';
import { providerForModel, providerForSttVendor, providerForTtsVendor } from './utils/provider-keys.js';

/**
 * The provider slugs a call running this agent could actually use: its model,
 * pipeline STT/TTS vendors, and any fallback model. This is the filter applied
 * before distributing keys — a worker never sees org keys for providers the
 * agent doesn't reference.
 *
 * STT/TTS vendors are resolved worker-side with defaults the agent row does
 * not record (STT defaults to deepgram on both workers; TTS is defaulted or
 * inferred from the voice per worker; bridged-transfer transcription taps
 * build STT even for realtime models), so for the livekit/pipecat families an
 * UNSET vendor ships every key the worker's own defaulting could consume —
 * only an explicit vendor narrows to that vendor's provider.
 *
 * @param {object} agent the Agent row (or plain agent JSON)
 * @returns {Set<string>} canonical provider slugs
 */
export function providersForAgent(agent) {
  const providers = new Set();
  const add = (slug) => slug && providers.add(slug);
  const modelName = agent?.modelName;
  const family = typeof modelName === 'string' && modelName.includes(':') ? modelName.split(':')[0] : null;
  // jambonz-family agents are out of BYOK scope in v1 (docs/byok.md); their
  // worker never fetches the agent-db document, so ship nothing for them.
  if (family === 'jambonz') return providers;
  add(providerForModel(modelName));
  const fallbackModel = agent?.options?.fallback?.model;
  if (typeof fallbackModel !== 'string' || !fallbackModel.startsWith('jambonz:')) {
    add(providerForModel(fallbackModel));
  }
  if (family === 'livekit' || family === 'pipecat') {
    const sttVendor = agent?.options?.stt?.vendor;
    add(sttVendor ? providerForSttVendor(sttVendor) : 'deepgram');
    const ttsVendor = agent?.options?.tts?.vendor;
    if (ttsVendor) {
      add(providerForTtsVendor(ttsVendor));
    } else {
      ['cartesia', 'elevenlabs', 'deepgram'].forEach(add);
    }
  }
  return providers;
}

/**
 * Decrypted org keys for the stored subset of `providers`. Providers with no
 * stored row are OMITTED (platform behaviour unchanged); a stored value that
 * fails to decrypt is present with value null — consumers MUST treat null as
 * fatal for that provider (fail-closed, no silent platform-key fallback).
 *
 * @param {string} organisationId
 * @param {Set<string>|string[]} providers canonical slugs (from providersForAgent)
 * @returns {Promise<object>} { [slug]: decryptedValue | null }
 */
export async function resolveOrganisationKeys(organisationId, providers) {
  const wanted = [...(providers || [])];
  if (!organisationId || !wanted.length) return {};
  const rows = await OrganisationKey.findAll({ where: { organisationId, provider: wanted } });
  const keys = {};
  for (const row of rows) {
    keys[row.provider] = row.value; // getter decrypts; null = undecryptable
  }
  return keys;
}

export default { providersForAgent, resolveOrganisationKeys };
