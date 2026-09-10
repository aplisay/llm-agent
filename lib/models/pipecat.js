const { PIPECAT_WORKER_URL, PIPECAT_DISPATCH_TOKEN } = process.env;
import Llm from './llm.js';

/**
 * Speech-to-speech (provider does STT + LLM + TTS in one stage). Mode = realtime.
 *
 * A row may carry a fourth element: per-model flag overrides applied on top of
 * the provider-level defaults (see `realtimeFlagsFor`). GPT-Live is the first
 * such row: it shares the `openai` provider segment with OpenAI Realtime, but
 * it has no text-output mode (`externalTts: false`) and it delegates reasoning
 * and tool use to a backend text agent (`delegation: true`, docs/gpt-live.md).
 */
const REALTIME_MODEL_ROWS = [
  ["openai", "gpt-realtime", "OpenAI Realtime (Pipecat)"],
  ["openai", "gpt-live-1", "OpenAI GPT-Live (Pipecat)", { externalTts: false, delegation: true }],
  ["google", "gemini-2.0-flash-exp", "Google Gemini 2.0 Live (Pipecat)"],
  ["ultravox", "ultravox-v0.6", "Ultravox 0.6 (Pipecat realtime)"],
  ["ultravox", "ultravox-v0.6-gemma3-27b", "Ultravox 0.6 gemma3-27b (Pipecat realtime)"],
  ["ultravox", "ultravox-v0.7", "Ultravox 0.7 (GLM 4.6) (Pipecat realtime)"]
];

/**
 * STT–LLM–TTS pipeline. Mode = pipeline. Agent options.stt / options.tts pick the
 * provider for each stage; the modelName picks the LLM.
 *
 * Single source of truth — the worker reads this list via the matching Python module
 * agents/pipecat/pipecat_aplisay/pipeline_model_ids.py (kept manually in sync per the
 * note in section 4.2 of docs/livekit-agent-architecture.md).
 */
const PIPELINE_MODEL_ROWS = [
  ["openai", "gpt-4o-mini", "OpenAI GPT-4o mini (Pipecat pipeline)"],
  ["openai", "gpt-4o", "OpenAI GPT-4o (Pipecat pipeline)"],
  ["openai", "gpt-5-mini", "OpenAI GPT-5 mini (Pipecat pipeline)"],
  ["google", "gemini-2.5-flash", "Google Gemini 2.5 Flash (Pipecat pipeline)"],
  ["google", "gemini-2.0-flash", "Google Gemini 2.0 Flash (Pipecat pipeline)"],
  ["anthropic", "claude-sonnet-4-5", "Anthropic Claude Sonnet 4.5 (Pipecat pipeline)"]
];

const pipelineFlag = { voiceStack: 'pipeline', audioModel: false, pipeline: true };
const realtimeFlag = { voiceStack: 'realtime', audioModel: true, pipeline: false };

/**
 * Realtime providers the worker can run in text-output mode with an external
 * TTS: `options.tts.vendor` set to a vendor other than the provider's own makes
 * the model emit text and a discrete TTS speak it (docs/realtime-external-tts.md).
 * Surfaced per row as the `externalTts` flag (`hasExternalTts` on GET /models).
 * The flag is computed PER MODEL ID: the provider default here can be overridden
 * by a row (GPT-Live is an `openai` row with no text-output mode).
 * Must match TEXT_OUTPUT_PROVIDERS / TEXT_OUTPUT_EXCLUDED_MODEL_IDS in
 * agents/pipecat/pipecat_aplisay/realtime_tts.py.
 * Gemini is absent: no Live model the API still serves accepts a TEXT response modality.
 */
const EXTERNAL_TTS_PROVIDERS = new Set(['ultravox', 'openai']);
const realtimeFlagsFor = (vendor, overrides = {}) => ({
  ...realtimeFlag,
  ...(EXTERNAL_TTS_PROVIDERS.has(vendor) ? { externalTts: true } : {}),
  ...overrides,
});

/**
 * Map of `provider/modelId` (without `pipecat:`) -> flags for the worker.
 */
export const pipecatModelIdFlags = Object.fromEntries([
  ...REALTIME_MODEL_ROWS.map(([a, b, , overrides]) => [`${a}/${b}`, realtimeFlagsFor(a, overrides)]),
  ...PIPELINE_MODEL_ROWS.map(([a, b]) => [`${a}/${b}`, pipelineFlag]),
]);

/**
 * @param {string} modelId e.g. `ultravox/ultravox-v0.7` (segment after `pipecat:`)
 * @returns {boolean} the row may pair the realtime model with an external TTS
 */
export function pipecatModelSupportsExternalTts(modelId) {
  return pipecatModelIdFlags[modelId]?.externalTts === true;
}

/**
 * @param {string} modelId e.g. `openai/gpt-live-1` (segment after `pipecat:`)
 * @returns {boolean} the row delegates to a backend text agent, so it accepts
 *   a builtin `delegate` function (docs/gpt-live.md)
 */
export function pipecatModelSupportsDelegation(modelId) {
  return pipecatModelIdFlags[modelId]?.delegation === true;
}

/**
 * True for the OpenAI GPT-Live rows (`openai/gpt-live*`). They share the `openai`
 * provider segment with OpenAI Realtime but speak with their own voice list and
 * run a two-layer (voice model + backend text model) session. Must match
 * is_gpt_live_model_id in agents/pipecat/pipecat_aplisay/gpt_live.py.
 *
 * @param {string} modelId segment after `pipecat:`
 * @returns {boolean}
 */
export function isPipecatGptLiveModelId(modelId) {
  return /^openai\/gpt-live/.test(String(modelId || ''));
}

export const PIPECAT_PIPELINE_MODEL_IDS = PIPELINE_MODEL_ROWS.map(([v, m]) => `${v}/${m}`);

/**
 * @param {string} modelId e.g. `openai/gpt-4o-mini` (segment after `pipecat:`)
 * @returns {boolean}
 */
export function isPipecatPipelineModelId(modelId) {
  return pipecatModelIdFlags[modelId]?.voiceStack === 'pipeline';
}

class Pipecat extends Llm {

  static handler = 'pc_realtime';

  static allModels = [
    ...REALTIME_MODEL_ROWS.map((r) => {
      const [vendor, name, description, overrides] = r;
      return [`${vendor}/${name}`, description, realtimeFlagsFor(vendor, overrides)];
    }),
    ...PIPELINE_MODEL_ROWS.map((r) => {
      const [vendor, name, description] = r;
      return [`${vendor}/${name}`, description, pipelineFlag];
    }),
  ];

  static get needKey() {
    return { PIPECAT_WORKER_URL, PIPECAT_DISPATCH_TOKEN };
  }

  static supportsFunctions = (model) => true;

  // The Pipecat worker connects to configured MCP servers itself and exposes
  // their tools to the model as client tools, so MCP is supported across all
  // Pipecat-routed models (Ultravox realtime first, others for free).
  static supportsMcp = (model) => true;

  static audioModel = true;

  constructor({ modelName } = {}) {
    super(...arguments);
    this.model = modelName || Pipecat.allModels[0][0];
    this.logger.debug({ thisPrompt: this.prompt }, 'NEW Pipecat agent');
  }
}

export default Pipecat;
