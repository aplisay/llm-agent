/**
 * Image-only shim for the shared-lib import of compiled LiveKit output; remove with issue #123.
 * Keep model rows and flags in sync with agents/livekit/lib/livekit-model-registry.ts.
 */

/** Speech-to-speech (builtin STT/TTS in the realtime model). */
const LIVEKIT_REALTIME_MODEL_ROWS = [
  ["openai", "gpt-realtime", "OpenAI (Livekit realtime)"],
  ["ultravox", "ultravox-70b", "Ultravox 70B (Livekit realtime)"],
  ["ultravox", "ultravox-v0.6", "Ultravox 0.6 (Livekit realtime)"],
  ["ultravox", "ultravox-v0.6-gemma3-27b", "Ultravox 0.6 (Livekit realtime)"],
  ["ultravox", "ultravox-v0.7", "Ultravox 0.7 (GLM 4.6) (Livekit realtime)"],
  ["google", "gemini-2.5-flash-native-audio-preview-12-2025", "Google Gemini 2.5 Flash Live (Livekit realtime)"],
  ["google", "gemini-2.0-flash-exp", "Google Gemini 2.0 Live (Livekit realtime, retired: runs Gemini 2.5 Flash Live)"],
];

/** STT–LLM–TTS via LiveKit Inference. */
const LIVEKIT_PIPELINE_MODEL_ROWS = [
  ["openai", "gpt-4o-mini", "OpenAI GPT-4o mini (LiveKit pipeline)"],
  ["openai", "gpt-4o", "OpenAI GPT-4o (LiveKit pipeline)"],
  ["openai", "gpt-5-mini", "OpenAI GPT-5 mini (LiveKit pipeline)"],
  ["google", "gemini-2.5-flash", "Google Gemini 2.5 Flash (LiveKit pipeline)"],
  ["google", "gemini-2.0-flash", "Google Gemini 2.0 Flash (LiveKit pipeline)"],
];

const pipelineFlag = { voiceStack: "pipeline", audioModel: false, pipeline: true };
const realtimeFlag = { voiceStack: "realtime", audioModel: true, pipeline: false };

export const livekitModelIdFlags = Object.fromEntries([
  ...LIVEKIT_REALTIME_MODEL_ROWS.map(([a, b]) => [`${a}/${b}`, realtimeFlag]),
  ...LIVEKIT_PIPELINE_MODEL_ROWS.map(([a, b]) => [`${a}/${b}`, pipelineFlag]),
]);

export function isLivekitPipelineModelId(modelId) {
  return livekitModelIdFlags[modelId]?.voiceStack === "pipeline";
}

export function buildLivekitHandlerAllModels() {
  return [
    ...LIVEKIT_REALTIME_MODEL_ROWS.map((r) => {
      const [vendor, name, description] = r;
      return [`${vendor}/${name}`, description, realtimeFlag];
    }),
    ...LIVEKIT_PIPELINE_MODEL_ROWS.map((r) => {
      const [vendor, name, description] = r;
      return [`${vendor}/${name}`, description, pipelineFlag];
    }),
  ];
}
