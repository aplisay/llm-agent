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

  const voiceTree = await impl.voices;
  return { locales: mergeLocaleKeys(voiceTree), voiceStack: handler === 'livekit' ? 'realtime' : undefined };
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

  const voiceTree = await impl.voices;
  const vendors = {};
  for (const [vendor, locMap] of Object.entries(voiceTree || {})) {
    const arr = locMap?.[locale];
    if (Array.isArray(arr) && arr.length) vendors[vendor] = arr;
  }
  return { vendors, voiceStack: handler === 'livekit' ? 'realtime' : undefined };
}
