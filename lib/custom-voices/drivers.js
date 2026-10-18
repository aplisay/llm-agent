/**
 * Which vendor can make which kind of custom voice, and which models can speak
 * it (docs/implementation/custom-voices.md). No database access, so lib/database.js can use it
 * when it validates an agent.
 *
 * A driver is keyed by the lowercased vendor slug stored on the row. Each method
 * ('prompt', 'recording') names the models that can use a voice made that way
 * and the function that creates it. `deleteVoice`, when the vendor has one,
 * removes the voice there. `vendorName` and `findVoice` let an interrupted
 * create be finished from the vendor's own list. Add a vendor by adding a
 * driver here.
 */
import { livekitModelIdFlags } from '../models/livekit.js';
import { isPipecatGptLiveModelId, pipecatModelIdFlags } from '../models/pipecat.js';
import {
  createOpenAIPromptVoice,
  deleteOpenAIVoice,
  findOpenAIVoiceByName,
  openaiVoiceName,
  openaiCustomVoicesConfigured,
  OPENAI_PROMPT_MAX_CHARS,
  OPENAI_PROMPT_VOICE_PLATFORM_LIMIT,
  OPENAI_SCRIPT_HINT_MAX_CHARS,
} from './openai.js';

function splitModel(modelName) {
  const s = String(modelName || '');
  const i = s.indexOf(':');
  return i === -1 ? { handler: '', rest: s } : { handler: s.slice(0, i), rest: s.slice(i + 1) };
}

/** A GPT-Live row that exists in a handler's model registry. */
export function isGptLiveModel(modelName) {
  const { handler, rest } = splitModel(modelName);
  if (!isPipecatGptLiveModelId(rest)) return false;
  if (handler === 'pipecat') return Boolean(pipecatModelIdFlags[rest]);
  if (handler === 'livekit') return Boolean(livekitModelIdFlags?.[rest]);
  return false;
}

/** Every model id the registries know, with its handler prefix. */
export function allModelNames() {
  return [
    ...Object.keys(pipecatModelIdFlags).map((id) => `pipecat:${id}`),
    ...Object.keys(livekitModelIdFlags || {}).map((id) => `livekit:${id}`),
  ];
}

export const CUSTOM_VOICE_DRIVERS = {
  openai: {
    vendor: 'openai',
    // The vendor key the model's voice tree lists OpenAI voices under.
    catalogueVendor: 'OpenAI',
    label: 'OpenAI',
    configured: openaiCustomVoicesConfigured,
    deleteVoice: deleteOpenAIVoice,
    vendorName: openaiVoiceName,
    findVoice: findOpenAIVoiceByName,
    methods: {
      prompt: {
        supportsModel: isGptLiveModel,
        create: createOpenAIPromptVoice,
        promptMaxChars: OPENAI_PROMPT_MAX_CHARS,
        scriptHintMaxChars: OPENAI_SCRIPT_HINT_MAX_CHARS,
        platformLimitEnv: 'OPENAI_PROMPT_VOICE_PLATFORM_LIMIT',
        platformLimitDefault: OPENAI_PROMPT_VOICE_PLATFORM_LIMIT,
      },
    },
  },
};

/** Vendors with no delete call: their deleted voices still hold a slot, so they still count. */
export function vendorsHoldingDeletedVoices() {
  return Object.values(CUSTOM_VOICE_DRIVERS).filter((d) => !d.deleteVoice).map((d) => d.vendor);
}

export function driverFor(vendor) {
  return CUSTOM_VOICE_DRIVERS[String(vendor || '').toLowerCase()] || null;
}

/** The method entry for a stored row, or null when the vendor or method is unknown. */
export function methodFor(vendor, method) {
  return driverFor(vendor)?.methods?.[method] || null;
}

/**
 * The vendors that can create a voice of `method` for `modelName`.
 *
 * @returns {string[]} vendor slugs
 */
export function vendorsForModel(modelName, method) {
  return Object.values(CUSTOM_VOICE_DRIVERS)
    .filter((d) => d.methods?.[method]?.supportsModel(modelName))
    .map((d) => d.vendor);
}

/** True when any vendor method can make a voice `modelName` speaks. */
export function modelSupportsCustomVoices(modelName) {
  return Object.values(CUSTOM_VOICE_DRIVERS)
    .some((d) => Object.values(d.methods || {}).some((m) => m.supportsModel(modelName)));
}

/** True when a voice made by `vendor` with `method` can be spoken by `modelName`. */
export function customVoiceSupportsModel({ vendor, method }, modelName) {
  return methodFor(vendor, method)?.supportsModel(modelName) === true;
}

/** The model names a voice can be used on, for the API view. */
export function modelsForCustomVoice({ vendor, method }) {
  const m = methodFor(vendor, method);
  return m ? allModelNames().filter((name) => m.supportsModel(name)) : [];
}

/** The platform-wide cap for a vendor method: its env override, else the vendor's own cap. */
export function platformLimitFor(vendor, method) {
  const m = methodFor(vendor, method);
  if (!m?.platformLimitEnv) return null;
  const raw = process.env[m.platformLimitEnv];
  if (raw === undefined || raw === '') return m.platformLimitDefault ?? null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : (m.platformLimitDefault ?? null);
}
