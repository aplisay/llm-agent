const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
import Llm from './llm.js';

/** Speech-to-speech (builtin STT/TTS in the realtime model). */
const REALTIME_MODEL_ROWS = [
  ["openai", "gpt-realtime", "OpenAI (Livekit realtime)"],
  ["ultravox", "ultravox-v0.6", "Ultravox 0.6 (Livekit realtime)"],
  ["ultravox", "ultravox-v0.6-gemma3-27b", "Ultravox 0.6 (Livekit realtime)"],
  ["ultravox", "ultravox-v0.7", "Ultravox 0.7 (GLM 4.6) (Livekit realtime)"],
  ["google", "gemini-2.0-flash-exp", "Google Gemini 2.0 (Livekit realtime)"]
];

/**
 * STT–LLM–TTS via LiveKit Inference. Agent `options.stt` / `options.tts` (vendor, language, voice)
 * select providers; LLM id matches LiveKit Inference model strings.
 */
const PIPELINE_MODEL_ROWS = [
  ["openai", "gpt-4o-mini", "OpenAI GPT-4o mini (LiveKit pipeline)"],
  ["openai", "gpt-4o", "OpenAI GPT-4o (LiveKit pipeline)"],
  ["openai", "gpt-5-mini", "OpenAI GPT-5 mini (LiveKit pipeline)"],
  ["google", "gemini-2.5-flash", "Google Gemini 2.5 Flash (LiveKit pipeline)"],
  ["google", "gemini-2.0-flash", "Google Gemini 2.0 Flash (LiveKit pipeline)"],
];

const pipelineFlag = { voiceStack: 'pipeline', audioModel: false, pipeline: true };
const realtimeFlag = { voiceStack: 'realtime', audioModel: true, pipeline: false };

/**
 * Map of `provider/modelId` (without `livekit:`) -> flags for the LiveKit worker.
 */
export const livekitModelIdFlags = Object.fromEntries([
  ...REALTIME_MODEL_ROWS.map(([a, b]) => [`${a}/${b}`, realtimeFlag]),
  ...PIPELINE_MODEL_ROWS.map(([a, b]) => [`${a}/${b}`, pipelineFlag]),
]);

/**
 * @param {string} modelId e.g. `openai/gpt-4o-mini` (segment after `livekit:`)
 * @returns {boolean}
 */
export function isLivekitPipelineModelId(modelId) {
  return livekitModelIdFlags[modelId]?.voiceStack === 'pipeline';
}

/**
 * Implements the LLM class against the Livekit model
 *
 * @class Livekit
 * @extends {Llm}
 */
class Livekit extends Llm {

  static handler = 'lk_realtime';

  /**
   * Each entry: [`${vendor}/${shortName}`, description, flags?]
   * flags: { voiceStack: 'realtime'|'pipeline', audioModel: boolean, pipeline: boolean }
   */
  static allModels = [
    ...REALTIME_MODEL_ROWS.map((r) => {
      const [vendor, name, description] = r;
      return [`${vendor}/${name}`, description, realtimeFlag];
    }),
    ...PIPELINE_MODEL_ROWS.map((r) => {
      const [vendor, name, description] = r;
      return [`${vendor}/${name}`, description, pipelineFlag];
    }),
  ];

  static get needKey() {
    return { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL };
  }

  static supportsFunctions = (model) => true;

  /** Class default; per-model `audioModel` comes from allModels row flags in GET /models */
  static audioModel = true;


  constructor({ modelName } = {}) {
    super(...arguments);
    this.model = modelName || Livekit.allModels[0][0];
    this.logger.debug({ thisPrompt: this.prompt }, 'NEW Livekit agent');
  }
}

export default Livekit;
