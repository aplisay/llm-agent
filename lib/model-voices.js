import handlers from './handlers/index.js';
import { transformVoiceTreeForLiveKitPipeline } from './deepgram-livekit-inference-voice.js';
import { isLivekitPipelineModelId } from './models/livekit.js';
import { isPipecatPipelineModelId } from './models/pipecat.js';

/**
 * LiveKit **pipeline** on Node uses Inference TTS + Gemini TTS, not Google Cloud voice catalogue ids.
 * Omit the `google` vendor from API voice lists so UIs do not offer unusable options.
 * (Agent validation still allows existing `google` + Cloud id values via the full tree.)
 *
 * @param {Record<string, Record<string, unknown[]>>} vendorTree
 * @returns {Record<string, Record<string, unknown[]>>}
 */
function voiceTreeWithoutGoogleVendorForPipelineList(vendorTree) {
  if (!vendorTree || typeof vendorTree !== 'object') return vendorTree;
  const out = { ...vendorTree };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === 'google') delete out[key];
  }
  return out;
}

/**
 * LiveKit realtime `Handler.voices` merges blocks keyed exactly as in `lib/handlers/livekit.js`
 * (`ultravox`, `OpenAI`). Scope API lists to the model provider (`rest` is `vendor/modelId`).
 *
 * @param {string} rest e.g. `openai/gpt-realtime`, `ultravox/ultravox-v0.7`
 * @returns {Set<string> | null}
 *   `Set` = filter to those keys; empty set = no catalogue rows (e.g. Google realtime);
 *   `null` = unknown provider segment — keep the merged tree (custom / future ids).
 */
function livekitRealtimeVoiceVendorsForRestModelId(rest) {
  const s = String(rest || '');
  const i = s.indexOf('/');
  const provider = i === -1 ? '' : s.slice(0, i).toLowerCase();
  if (provider === 'openai') return new Set(['OpenAI']);
  if (provider === 'ultravox') return new Set(['ultravox']);
  if (provider === 'google') return new Set();
  if (!provider) return new Set();
  return null;
}

/**
 * Pipecat realtime: each model has exactly one speech provider that ships its
 * own voice catalogue (OpenAI Realtime, Gemini Live). Scope API lists to the
 * model's provider segment so the picker never offers another vendor's voice
 * to a provider that can't speak it.
 *
 * @param {string} rest e.g. `openai/gpt-realtime`, `google/gemini-2.0-flash-exp`
 * @returns {Set<string> | null}
 *   `Set` = filter to those keys; empty set = no catalogue rows;
 *   `null` = unknown provider segment — keep the merged tree.
 */
function pipecatRealtimeVoiceVendorsForRestModelId(rest) {
  const s = String(rest || '');
  const i = s.indexOf('/');
  const provider = i === -1 ? '' : s.slice(0, i).toLowerCase();
  if (provider === 'openai') return new Set(['OpenAI']);
  if (provider === 'google') return new Set(['google']);
  if (provider === 'ultravox') return new Set(['ultravox']);
  if (!provider) return new Set();
  return null;
}

/**
 * STT providers available for Pipecat **pipeline** models. Mirrors what
 * `agents/pipecat/pipecat_aplisay/voice_session.py` actually wires up in its
 * pipeline-mode build. Add a vendor here only after the worker can route to it.
 */
const PIPECAT_PIPELINE_STT_PROVIDERS = [
  { name: 'deepgram', description: 'Deepgram (Nova)' },
  { name: 'google', description: 'Google Cloud Speech-to-Text V2' },
];

/**
 * TTS vendor allow-list for Pipecat **pipeline** models. Keys match the
 * top-level vendor names emitted by `lib/voices/*.js` (`deepgram`,
 * `elevenlabs`, `google`, ...). Only listed vendors are surfaced through
 * GET /models/.../voices/... — the worker errors on anything else.
 *
 * Keep aligned with the TTS branch in
 * `agents/pipecat/pipecat_aplisay/voice_session.py`.
 */
const PIPECAT_PIPELINE_TTS_VENDORS = new Set([
  'deepgram',
  'elevenlabs',
  // 'cartesia' is supported by the worker but absent from the platform voice
  // catalogue (no lib/voices/cartesia.js). It can still be selected by setting
  // agent.options.tts manually; once a catalogue source lands, add 'cartesia'
  // here and getVoiceNamesForAgentValidation will accept its voice names.
]);

/**
 * Restrict a vendor tree to the Pipecat pipeline TTS allow-list.
 *
 * @param {Record<string, Record<string, unknown[]>>} voiceTree
 * @returns {Record<string, Record<string, unknown[]>>}
 */
function pipecatPipelineTtsTree(voiceTree) {
  if (!voiceTree || typeof voiceTree !== 'object') return {};
  const out = {};
  for (const [vendor, locMap] of Object.entries(voiceTree)) {
    if (PIPECAT_PIPELINE_TTS_VENDORS.has(vendor.toLowerCase())) {
      out[vendor] = locMap;
    }
  }
  return out;
}

/**
 * Locale fallback for vendor → locale → voices[] trees.
 *
 * Realtime providers (OpenAI Realtime, Gemini Live) advertise locale-neutral
 * timbres under the `'any'` key — the model speaks whatever language the
 * conversation is in, so the same voices are available at any locale. When the
 * caller asks for `en-GB` and the vendor only has `any`, fall back to `any` so
 * the UI sees the voices instead of an empty list.
 *
 * @param {Record<string, unknown[]>} locMap vendor's locale → voices map
 * @param {string} locale requested locale
 * @returns {unknown[] | undefined}
 */
function voicesForLocaleWithAnyFallback(locMap, locale) {
  if (!locMap || typeof locMap !== 'object') return undefined;
  const exact = locMap[locale];
  if (Array.isArray(exact) && exact.length) return exact;
  const any = locMap.any;
  if (Array.isArray(any) && any.length) return any;
  return undefined;
}

/**
 * @param {Record<string, Record<string, unknown[]>>} voiceTree
 * @param {Set<string> | null} allowedVendors exact top-level keys to keep; `null` = no filtering
 */
function filterVoiceTreeVendors(voiceTree, allowedVendors) {
  if (!voiceTree || typeof voiceTree !== 'object') return {};
  if (allowedVendors == null) return voiceTree;
  if (!(allowedVendors instanceof Set) || allowedVendors.size === 0) return {};
  const out = {};
  for (const [vendor, locMap] of Object.entries(voiceTree)) {
    if (allowedVendors.has(vendor)) out[vendor] = locMap;
  }
  return out;
}

/**
 * @param {string} modelName
 * @returns {{ handler: string | null, rest: string | null }}
 */
export function splitHandlerModel(modelName) {
  if (modelName == null || typeof modelName !== 'string') {
    return { handler: null, rest: null };
  }
  const idx = modelName.indexOf(':');
  if (idx === -1) return { handler: null, rest: modelName };
  return { handler: modelName.slice(0, idx), rest: modelName.slice(idx + 1) };
}

/**
 * Collect unique locale keys from nested vendor → locale → voices[] trees.
 * @param {Record<string, Record<string, unknown[]>>} vendorTree
 * @returns {string[]}
 */
export function mergeLocaleKeys(vendorTree) {
  const s = new Set();
  for (const locMap of Object.values(vendorTree || {})) {
    if (!locMap || typeof locMap !== 'object') continue;
    for (const loc of Object.keys(locMap)) {
      if (loc) s.add(loc);
    }
  }
  return [...s].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {import('./voices/index.js').default} voicesInstance
 * @returns {Promise<Record<string, Record<string, unknown[]>>>}
 */
async function pipelineVendorTrees(voicesInstance) {
  return voicesInstance.listVoices();
}

/**
 * @param {Record<string, Record<string, unknown[]>>} vendorTree
 * @param {string} locale
 * @returns {Record<string, unknown[]>}
 */
export function vendorsForLocale(vendorTree, locale) {
  const out = {};
  for (const [vendor, locMap] of Object.entries(vendorTree || {})) {
    const arr = voicesForLocaleWithAnyFallback(locMap, locale);
    if (Array.isArray(arr) && arr.length) out[vendor] = arr;
  }
  return out;
}

/**
 * Flatten `vendor → locale → { name, ... }[]` (same shape as handler `voices` maps).
 *
 * @param {Record<string, Record<string, unknown[]>>} voiceTree
 * @returns {Set<string>}
 */
export function collectVoiceNamesFromTree(voiceTree) {
  const names = new Set();
  for (const locMap of Object.values(voiceTree || {})) {
    if (!locMap || typeof locMap !== 'object') continue;
    for (const arr of Object.values(locMap)) {
      if (!Array.isArray(arr)) continue;
      for (const v of arr) {
        if (v && typeof v === 'object' && typeof v.name === 'string') names.add(v.name);
      }
    }
  }
  return names;
}

/**
 * Voice names allowed for `modelName` when validating `options.tts.voice`.
 * LiveKit **pipeline** models use Inference TTS (`voicesInstance.listVoices()`);
 * realtime LiveKit and other handlers use `Handler.voices`.
 *
 * @param {object} p
 * @param {string} p.modelName
 * @param {object} p.Handler handler class (with `.voices`)
 * @param {import('./voices/index.js').default} p.voicesInstance
 * @returns {Promise<Set<string>>}
 */
export async function getVoiceNamesForAgentValidation({ modelName, Handler, voicesInstance }) {
  const { handler, rest } = splitHandlerModel(modelName);
  if (!handler || !rest) return new Set();
  if (handler === 'livekit' && isLivekitPipelineModelId(rest)) {
    const rawTree = await pipelineVendorTrees(voicesInstance);
    const mappedTree = transformVoiceTreeForLiveKitPipeline(rawTree);
    return new Set([
      ...collectVoiceNamesFromTree(mappedTree),
      ...collectVoiceNamesFromTree(rawTree),
    ]);
  }
  if (handler === 'livekit') {
    const fullTree = await Handler.voices;
    const allowed = livekitRealtimeVoiceVendorsForRestModelId(rest);
    return collectVoiceNamesFromTree(filterVoiceTreeVendors(fullTree, allowed));
  }
  if (handler === 'pipecat' && isPipecatPipelineModelId(rest)) {
    // Pipeline mode: voice names come from the platform's TTS catalogue,
    // filtered to vendors the worker can actually instantiate.
    // Unlike LiveKit pipeline mode, Pipecat hits each TTS provider's native
    // API directly, so no transform is needed — the filtered catalogue names
    // are what the worker accepts verbatim.
    return collectVoiceNamesFromTree(
      pipecatPipelineTtsTree(await pipelineVendorTrees(voicesInstance)),
    );
  }
  if (handler === 'pipecat') {
    const fullTree = await Handler.voices;
    const allowed = pipecatRealtimeVoiceVendorsForRestModelId(rest);
    return collectVoiceNamesFromTree(filterVoiceTreeVendors(fullTree, allowed));
  }
  return collectVoiceNamesFromTree(await Handler.voices);
}

/**
 * GET /models/:modelName/voices — sorted BCP-47 (or provider-specific) locale list.
 *
 * @param {object} p
 * @param {string} p.modelName
 * @param {import('./voices/index.js').default} p.voicesInstance
 * @returns {Promise<{ locales: string[], voiceStack?: 'realtime' | 'pipeline' }>}
 */
export async function getModelVoiceLocales({ modelName, voicesInstance }) {
  const { handler, rest } = splitHandlerModel(modelName);
  if (!handler || !rest) {
    const err = new Error('Invalid modelName');
    err.statusCode = 400;
    throw err;
  }

  const { implementations } = await handlers();
  const impl = implementations.find((h) => h.name === handler);
  if (!impl) {
    const err = new Error(`Unknown handler: ${handler}`);
    err.statusCode = 404;
    throw err;
  }

  if (handler === 'livekit' && isLivekitPipelineModelId(rest)) {
    const tree = voiceTreeWithoutGoogleVendorForPipelineList(await pipelineVendorTrees(voicesInstance));
    return { locales: mergeLocaleKeys(tree), voiceStack: 'pipeline' };
  }

  if (handler === 'pipecat' && isPipecatPipelineModelId(rest)) {
    const tree = pipecatPipelineTtsTree(await pipelineVendorTrees(voicesInstance));
    return { locales: mergeLocaleKeys(tree), voiceStack: 'pipeline' };
  }

  let voiceTree = await impl.voices;
  if (handler === 'livekit') {
    voiceTree = filterVoiceTreeVendors(
      voiceTree,
      livekitRealtimeVoiceVendorsForRestModelId(rest),
    );
  } else if (handler === 'pipecat') {
    voiceTree = filterVoiceTreeVendors(
      voiceTree,
      pipecatRealtimeVoiceVendorsForRestModelId(rest),
    );
  }
  const stack =
    handler === 'livekit' || handler === 'pipecat' ? 'realtime' : undefined;
  return { locales: mergeLocaleKeys(voiceTree), voiceStack: stack };
}

/**
 * STT provider descriptors available for LiveKit **pipeline** models.
 * Mirrors the vendor selection logic in `agents/livekit/lib/pipeline-inference-options.ts`.
 */
const PIPELINE_STT_PROVIDERS = [
  { name: 'deepgram', description: 'Deepgram Nova 3' },
  { name: 'assemblyai', description: 'AssemblyAI Universal Streaming' },
  { name: 'cartesia', description: 'Cartesia Ink Whisper' },
];

/**
 * GET /models/:modelName/recognition/:locale — STT provider options for that locale.
 *
 * For LiveKit **pipeline** models returns the set of supported Inference STT vendors.
 * For all other model types returns an empty provider list (STT vendor is fixed).
 *
 * @param {object} p
 * @param {string} p.modelName
 * @param {string} p.locale
 * @returns {Promise<{ providers: { name: string, description: string }[], voiceStack?: 'realtime' | 'pipeline' }>}
 */
export async function getModelRecognitionForLocale({ modelName, locale }) {
  const { handler, rest } = splitHandlerModel(modelName);
  if (!handler || !rest) {
    const err = new Error('Invalid modelName');
    err.statusCode = 400;
    throw err;
  }
  if (!locale || typeof locale !== 'string') {
    const err = new Error('Invalid locale');
    err.statusCode = 400;
    throw err;
  }

  const { implementations } = await handlers();
  const impl = implementations.find((h) => h.name === handler);
  if (!impl) {
    const err = new Error(`Unknown handler: ${handler}`);
    err.statusCode = 404;
    throw err;
  }

  if (handler === 'livekit' && isLivekitPipelineModelId(rest)) {
    return { providers: PIPELINE_STT_PROVIDERS, voiceStack: 'pipeline' };
  }

  if (handler === 'pipecat' && isPipecatPipelineModelId(rest)) {
    return { providers: PIPECAT_PIPELINE_STT_PROVIDERS, voiceStack: 'pipeline' };
  }

  const stack =
    handler === 'livekit' || handler === 'pipecat' ? 'realtime' : undefined;
  return { providers: [], voiceStack: stack };
}

/**
 * GET /models/:modelName/voices/:locale — vendor → voice rows for that locale.
 *
 * @param {object} p
 * @param {string} p.modelName
 * @param {string} p.locale
 * @param {import('./voices/index.js').default} p.voicesInstance
 * @returns {Promise<{ vendors: Record<string, unknown[]>, voiceStack?: 'realtime' | 'pipeline' }>}
 */
export async function getModelVoicesForLocale({ modelName, locale, voicesInstance }) {
  const { handler, rest } = splitHandlerModel(modelName);
  if (!handler || !rest) {
    const err = new Error('Invalid modelName');
    err.statusCode = 400;
    throw err;
  }
  if (!locale || typeof locale !== 'string') {
    const err = new Error('Invalid locale');
    err.statusCode = 400;
    throw err;
  }

  const { implementations } = await handlers();
  const impl = implementations.find((h) => h.name === handler);
  if (!impl) {
    const err = new Error(`Unknown handler: ${handler}`);
    err.statusCode = 404;
    throw err;
  }

  if (handler === 'livekit' && isLivekitPipelineModelId(rest)) {
    const tree = transformVoiceTreeForLiveKitPipeline(
      voiceTreeWithoutGoogleVendorForPipelineList(await pipelineVendorTrees(voicesInstance)),
    );
    return { vendors: vendorsForLocale(tree, locale), voiceStack: 'pipeline' };
  }

  if (handler === 'pipecat' && isPipecatPipelineModelId(rest)) {
    // Filter the platform catalogue to vendors the worker can actually
    // instantiate (see PIPECAT_PIPELINE_TTS_VENDORS). No name transform —
    // Pipecat hits each vendor's native API and accepts the catalogue IDs
    // verbatim.
    const tree = pipecatPipelineTtsTree(await pipelineVendorTrees(voicesInstance));
    return { vendors: vendorsForLocale(tree, locale), voiceStack: 'pipeline' };
  }

  let voiceTree = await impl.voices;
  if (handler === 'livekit') {
    voiceTree = filterVoiceTreeVendors(
      voiceTree,
      livekitRealtimeVoiceVendorsForRestModelId(rest),
    );
  } else if (handler === 'pipecat') {
    voiceTree = filterVoiceTreeVendors(
      voiceTree,
      pipecatRealtimeVoiceVendorsForRestModelId(rest),
    );
  }
  const vendors = {};
  for (const [vendor, locMap] of Object.entries(voiceTree || {})) {
    // Use the locale-with-`any`-fallback lookup so realtime voices keyed
    // under `'any'` still appear for any requested locale.
    const arr = voicesForLocaleWithAnyFallback(locMap, locale);
    if (Array.isArray(arr) && arr.length) vendors[vendor] = arr;
  }
  const stack =
    handler === 'livekit' || handler === 'pipecat' ? 'realtime' : undefined;
  return { vendors, voiceStack: stack };
}
