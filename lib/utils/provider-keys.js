/**
 * BYOK provider registry (docs/byok.md) — the single source of truth for the
 * canonical provider slugs organisation keys are stored under, and the mapping
 * from the places an agent references a provider (model-string provider
 * segment, `options.stt.vendor`, `options.tts.vendor`) to those slugs.
 *
 * Pure module: no DB imports — shared by the API layer, lib/org-keys.js and
 * anything that needs to reason about provider slugs without a DB connection.
 */

// slug -> { label, dimensions }. `dimensions` describes where the key applies
// (llm / realtime / stt / tts) — informational, surfaced to key-management UIs.
export const PROVIDERS = {
  openai: { label: 'OpenAI', dimensions: ['llm', 'realtime'] },
  anthropic: { label: 'Anthropic', dimensions: ['llm'] },
  google: { label: 'Google (Gemini API key)', dimensions: ['llm', 'realtime'] },
  ultravox: { label: 'Ultravox', dimensions: ['realtime'] },
  deepgram: { label: 'Deepgram', dimensions: ['stt', 'tts'] },
  elevenlabs: { label: 'ElevenLabs', dimensions: ['tts'] },
  cartesia: { label: 'Cartesia', dimensions: ['tts'] },
  kimi: { label: 'Kimi (Moonshot)', dimensions: ['llm'] },
  openrouter: { label: 'OpenRouter', dimensions: ['llm'] },
  deepseek: { label: 'DeepSeek', dimensions: ['llm'] },
};

// Model-string provider segment -> canonical slug (segments not listed here
// are not BYOK-injectable in v1).
const MODEL_PROVIDER_SLUGS = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  ultravox: 'ultravox',
  'fixie-ai': 'ultravox',
  kimi: 'kimi',
  moonshot: 'kimi',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
};

// options.stt.vendor -> slug. Deepgram only in v1 (other STT vendors are not
// BYOK-injectable).
const STT_VENDOR_SLUGS = {
  deepgram: 'deepgram',
};

// options.tts.vendor -> slug. `google` TTS is deliberately absent
// (service-account auth, out of BYOK scope).
const TTS_VENDOR_SLUGS = {
  elevenlabs: 'elevenlabs',
  cartesia: 'cartesia',
  deepgram: 'deepgram',
};

/** Is `slug` a canonical provider slug organisation keys may be stored under? */
export function isKnownProvider(slug) {
  return typeof slug === 'string' && Object.hasOwn(PROVIDERS, slug);
}

/** The registry as a catalogue array for UIs: [{ id, label, dimensions }]. */
export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, { label, dimensions }]) => ({ id, label, dimensions: [...dimensions] }));
}

const lookup = (map, key) => {
  if (typeof key !== 'string') return null;
  const normalised = key.trim().toLowerCase();
  return Object.hasOwn(map, normalised) ? map[normalised] : null;
};

/**
 * The canonical slug for the provider segment of a `handler:provider/model`
 * string (e.g. `livekit:openai/gpt-realtime` -> 'openai'), or null when the
 * provider is not BYOK-injectable.
 */
export function providerForModel(modelName) {
  if (typeof modelName !== 'string' || !modelName) return null;
  const segment = modelName.split(':').pop().split('/')[0];
  return lookup(MODEL_PROVIDER_SLUGS, segment);
}

/**
 * The canonical slug for an `options.stt.vendor` value, or null. Vendor values
 * may be model-scoped ("deepgram/nova-3") — both workers split on '/' before
 * resolving, so the mapping must too.
 */
export function providerForSttVendor(vendor) {
  if (typeof vendor !== 'string') return null;
  return lookup(STT_VENDOR_SLUGS, vendor.split('/')[0]);
}

/** The canonical slug for an `options.tts.vendor` value, or null. Splits model-scoped values like the STT mapper. */
export function providerForTtsVendor(vendor) {
  if (typeof vendor !== 'string') return null;
  return lookup(TTS_VENDOR_SLUGS, vendor.split('/')[0]);
}

export default { PROVIDERS, isKnownProvider, listProviders, providerForModel, providerForSttVendor, providerForTtsVendor };
