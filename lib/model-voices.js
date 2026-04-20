import handlers from './handlers/index.js';
import { transformVoiceTreeForLiveKitPipeline } from './deepgram-livekit-inference-voice.js';
import { isLivekitPipelineModelId } from './models/livekit.js';

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
    const arr = locMap?.[locale];
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

  let voiceTree = await impl.voices;
  if (handler === 'livekit') {
    voiceTree = filterVoiceTreeVendors(
      voiceTree,
      livekitRealtimeVoiceVendorsForRestModelId(rest),
    );
  }
  return { locales: mergeLocaleKeys(voiceTree), voiceStack: handler === 'livekit' ? 'realtime' : undefined };
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

  return { providers: [], voiceStack: handler === 'livekit' ? 'realtime' : undefined };
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

  let voiceTree = await impl.voices;
  if (handler === 'livekit') {
    voiceTree = filterVoiceTreeVendors(
      voiceTree,
      livekitRealtimeVoiceVendorsForRestModelId(rest),
    );
  }
  const vendors = {};
  for (const [vendor, locMap] of Object.entries(voiceTree || {})) {
    const arr = locMap?.[locale];
    if (Array.isArray(arr) && arr.length) vendors[vendor] = arr;
  }
  return { vendors, voiceStack: handler === 'livekit' ? 'realtime' : undefined };
}
