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
 * Worker-supported pipeline TTS vendors that may be absent from the platform
 * voice catalogue (e.g. cartesia has no lib/voices source yet) but are still
 * valid when set on `agent.options.tts.vendor`. Keep aligned with the livekit
 * worker's pipeline-provider-keys.ts and the pipecat voice_session.py TTS branch.
 */
const PIPELINE_TTS_VENDORS = new Set(['elevenlabs', 'cartesia', 'deepgram', 'google']);

/**
 * Lowercased top-level vendor keys from a `vendor → locale → voices[]` tree.
 * @param {Record<string, Record<string, unknown[]>>} voiceTree
 * @returns {Set<string>}
 */
export function collectVendorNamesFromTree(voiceTree) {
  const names = new Set();
  for (const vendor of Object.keys(voiceTree || {})) {
    if (vendor) names.add(vendor.toLowerCase());
  }
  return names;
}

/**
 * TTS vendors allowed for `modelName` when validating `options.tts.vendor`.
 * Mirrors {@link getVoiceNamesForAgentValidation} but collects vendor keys, and
 * for pipeline models unions the worker-supported vendors so a manually-set
 * vendor the catalogue doesn't enumerate (e.g. cartesia) isn't falsely rejected.
 * An empty set means "could not determine" — callers should not reject then.
 *
 * @param {object} p
 * @param {string} p.modelName
 * @param {object} p.Handler
 * @param {import('./voices/index.js').default} p.voicesInstance
 * @returns {Promise<Set<string>>}
 */
export async function getTtsVendorsForAgentValidation({ modelName, Handler, voicesInstance }) {
  const { handler, rest } = splitHandlerModel(modelName);
  if (!handler || !rest) return new Set();
  if (handler === 'livekit' && isLivekitPipelineModelId(rest)) {
    const rawTree = await pipelineVendorTrees(voicesInstance);
    return new Set([
      ...collectVendorNamesFromTree(transformVoiceTreeForLiveKitPipeline(rawTree)),
      ...collectVendorNamesFromTree(rawTree),
      ...PIPELINE_TTS_VENDORS,
    ]);
  }
  if (handler === 'livekit') {
    return collectVendorNamesFromTree(
      filterVoiceTreeVendors(await Handler.voices, livekitRealtimeVoiceVendorsForRestModelId(rest)));
  }
  if (handler === 'pipecat' && isPipecatPipelineModelId(rest)) {
    return new Set([
      ...collectVendorNamesFromTree(pipecatPipelineTtsTree(await pipelineVendorTrees(voicesInstance))),
      ...PIPELINE_TTS_VENDORS,
    ]);
  }
  if (handler === 'pipecat') {
    return collectVendorNamesFromTree(
      filterVoiceTreeVendors(await Handler.voices, pipecatRealtimeVoiceVendorsForRestModelId(rest)));
  }
  return collectVendorNamesFromTree(await Handler.voices);
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
 * Normalise `list_voices` search input into a de-duplicated list of lowercase
 * tokens. Accepts an array (each element is itself tokenised) or a string, and
 * splits on whitespace and commas — so "british english", ["british","english"]
 * and ["british english"] all yield ['british','english'].
 *
 * @param {string[] | string | undefined | null} terms
 * @returns {string[]}
 */
export function normalizeSearchTerms(terms) {
  const items = Array.isArray(terms) ? terms : [terms];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    for (const tok of String(item ?? '').split(/[\s,]+/)) {
      const s = tok.trim().toLowerCase();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

/**
 * A term hits the haystack only where it STARTS at a word boundary (start of
 * string or after a non-letter/digit). Prefix continuation is allowed —
 * 'brit' finds 'british' — but mid-word hits are not: 'male' must NOT match
 * 'female'. (The old anywhere-substring union matched nearly the whole
 * catalogue for a gendered search, burying the real matches — a builder model
 * facing that wall repeatedly concluded the tool was broken.) Unicode-aware by
 * hand: JS regex \b is ASCII-only, so 'étienne' after a space would not sit
 * on a \b boundary.
 *
 * @param {string} hay lowercased haystack
 * @param {string} term lowercased search token
 * @returns {boolean}
 */
const WORD_CHAR = /[\p{L}\p{N}]/u;
function termHitsHay(hay, term) {
  let i = hay.indexOf(term);
  while (i !== -1) {
    if (i === 0 || !WORD_CHAR.test(hay[i - 1])) return true;
    i = hay.indexOf(term, i + 1);
  }
  return false;
}

/**
 * Ranked union search over a vendor → locale → voices[] tree. A voice is kept
 * when its name / description / gender / locale text contains ANY of `terms`
 * at a word start (see {@link termHitsHay}), so ['british','robotic'] returns
 * british voices OR robotic voices. Each kept voice carries the `matchedTerms`
 * that hit it, and each vendor's list is sorted most-terms-matched first
 * (stable within a rank), so an ['irish','female'] query surfaces the Irish
 * female voice at the top rather than at position ~50 of a noise wall. Each
 * kept voice carries its `locale` (omitted for the locale-neutral `any` key).
 * Empty `terms` matches nothing. `termMatches` counts hits per term across
 * all vendors — zeros included, so a miss ('geordie': 0) is explicit rather
 * than silently absent.
 *
 * @param {Record<string, Record<string, unknown[]>>} tree
 * @param {string[]} terms already-normalised lowercase tokens
 * @returns {{ vendors: Record<string, unknown[]>, termMatches: Record<string, number> }}
 */
export function filterVoiceTreeBySearch(tree, terms) {
  const vendors = {};
  const termMatches = Object.fromEntries((Array.isArray(terms) ? terms : []).map((t) => [t, 0]));
  if (!tree || typeof tree !== 'object' || !Array.isArray(terms) || terms.length === 0) {
    return { vendors, termMatches };
  }
  for (const [vendor, locMap] of Object.entries(tree)) {
    if (!locMap || typeof locMap !== 'object') continue;
    const matches = [];
    const seen = new Set();
    for (const [locale, arr] of Object.entries(locMap)) {
      if (!Array.isArray(arr)) continue;
      for (const v of arr) {
        if (!v || typeof v !== 'object' || typeof v.name !== 'string') continue;
        const hay = `${v.name} ${v.description || ''} ${v.gender || ''} ${locale}`.toLowerCase();
        const matchedTerms = terms.filter((t) => termHitsHay(hay, t));
        if (matchedTerms.length === 0) continue;
        const key = `${locale}|${v.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const t of matchedTerms) termMatches[t] += 1;
        matches.push({ ...(locale && locale !== 'any' ? { ...v, locale } : v), matchedTerms });
      }
    }
    if (matches.length) {
      matches.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length);
      vendors[vendor] = matches;
    }
  }
  return { vendors, termMatches };
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
  const { tree, voiceStack } = await buildModelVoiceTree({ modelName, voicesInstance });
  // `vendorsForLocale` uses the locale-with-`any`-fallback lookup so realtime
  // voices keyed under `'any'` still appear for any requested locale.
  return { vendors: vendorsForLocale(tree, locale), voiceStack };
}

/**
 * Resolve the vendor → locale → voices[] tree a model actually offers — the
 * same tree {@link getModelVoicesForLocale} serves, before locale selection.
 * Encapsulates the per-handler branching (livekit/pipecat pipeline vs realtime,
 * vendor scoping) so the per-locale lookup and {@link searchModelVoices} share
 * one source of truth.
 *
 * @param {object} p
 * @param {string} p.modelName
 * @param {import('./voices/index.js').default} p.voicesInstance
 * @returns {Promise<{ tree: Record<string, Record<string, unknown[]>>, voiceStack?: 'realtime' | 'pipeline' }>}
 */
async function buildModelVoiceTree({ modelName, voicesInstance }) {
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
    return {
      tree: transformVoiceTreeForLiveKitPipeline(
        voiceTreeWithoutGoogleVendorForPipelineList(await pipelineVendorTrees(voicesInstance)),
      ),
      voiceStack: 'pipeline',
    };
  }

  if (handler === 'pipecat' && isPipecatPipelineModelId(rest)) {
    // Filter the platform catalogue to vendors the worker can actually
    // instantiate (see PIPECAT_PIPELINE_TTS_VENDORS). No name transform —
    // Pipecat hits each vendor's native API and accepts the catalogue IDs
    // verbatim.
    return {
      tree: pipecatPipelineTtsTree(await pipelineVendorTrees(voicesInstance)),
      voiceStack: 'pipeline',
    };
  }

  let tree = await impl.voices;
  if (handler === 'livekit') {
    tree = filterVoiceTreeVendors(tree, livekitRealtimeVoiceVendorsForRestModelId(rest));
  } else if (handler === 'pipecat') {
    tree = filterVoiceTreeVendors(tree, pipecatRealtimeVoiceVendorsForRestModelId(rest));
  }
  const voiceStack = handler === 'livekit' || handler === 'pipecat' ? 'realtime' : undefined;
  return { tree, voiceStack };
}

/**
 * Ranked union search across a model's FULL voice catalogue — every locale,
 * every vendor the model can use. Powers the `search` mode of the list_voices
 * builtin: the builder passes accent / gender / language / persona terms
 * (e.g. ['irish','female']) and gets back every matching voice, best matches
 * (most distinct terms hit) first, each carrying the `matchedTerms` that hit
 * it. Terms match at word starts only ('male' never matches 'female');
 * `termMatches` counts per-term hits and `unmatchedTerms` lists terms that
 * hit nothing, so "that accent is not in this catalogue" is an explicit
 * answer, never an inference from a noisy result.
 *
 * @param {object} p
 * @param {string} p.modelName
 * @param {string[] | string} p.terms search tokens (array or string)
 * @param {import('./voices/index.js').default} p.voicesInstance
 * @returns {Promise<{ vendors: Record<string, unknown[]>, voiceStack?: 'realtime' | 'pipeline', search: string[], termMatches: Record<string, number>, unmatchedTerms: string[] }>}
 */
export async function searchModelVoices({ modelName, terms, voicesInstance }) {
  const search = normalizeSearchTerms(terms);
  const { tree, voiceStack } = await buildModelVoiceTree({ modelName, voicesInstance });
  const { vendors, termMatches } = filterVoiceTreeBySearch(tree, search);
  const unmatchedTerms = search.filter((t) => !termMatches[t]);
  return { vendors, voiceStack, search, termMatches, unmatchedTerms };
}

