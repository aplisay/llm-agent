/**
 * Canonical LiveKit model registry for the realtime worker and the API server.
 * Emitted to `dist/lib/` by tsup/tsc; `lib/models/livekit.js` imports that output.
 */

/** Speech-to-speech (builtin STT/TTS in the realtime model). */
export const LIVEKIT_REALTIME_MODEL_ROWS = [
  ["openai", "gpt-realtime", "OpenAI (Livekit realtime)"],
  ["ultravox", "ultravox-70b", "Ultravox 70B (Livekit realtime)"],
  ["ultravox", "ultravox-v0.6", "Ultravox 0.6 (Livekit realtime)"],
  ["ultravox", "ultravox-v0.6-gemma3-27b", "Ultravox 0.6 (Livekit realtime)"],
  ["ultravox", "ultravox-v0.7", "Ultravox 0.7 (GLM 4.6) (Livekit realtime)"],
  ["google", "gemini-2.0-flash-exp", "Google Gemini 2.0 (Livekit realtime)"],
] as const;

/**
 * STT–LLM–TTS via LiveKit Inference. Agent `options.stt` / `options.tts` select providers;
 * LLM id matches LiveKit Inference model strings.
 */
export const LIVEKIT_PIPELINE_MODEL_ROWS = [
  ["openai", "gpt-4o-mini", "OpenAI GPT-4o mini (LiveKit pipeline)"],
  ["openai", "gpt-4o", "OpenAI GPT-4o (LiveKit pipeline)"],
  ["openai", "gpt-5-mini", "OpenAI GPT-5 mini (LiveKit pipeline)"],
  ["google", "gemini-2.5-flash", "Google Gemini 2.5 Flash (LiveKit pipeline)"],
  ["google", "gemini-2.0-flash", "Google Gemini 2.0 Flash (LiveKit pipeline)"],
] as const;

const pipelineFlag = {
  voiceStack: "pipeline" as const,
  audioModel: false,
  pipeline: true,
};
const realtimeFlag = {
  voiceStack: "realtime" as const,
  audioModel: true,
  pipeline: false,
};

/**
 * Map of `provider/modelId` (segment after `livekit:`) -> flags for routing (realtime vs pipeline).
 */
export const livekitModelIdFlags: Record<
  string,
  { voiceStack: "pipeline" | "realtime"; audioModel: boolean; pipeline: boolean }
> = Object.fromEntries([
  ...LIVEKIT_REALTIME_MODEL_ROWS.map(([a, b]) => [`${a}/${b}`, realtimeFlag]),
  ...LIVEKIT_PIPELINE_MODEL_ROWS.map(([a, b]) => [`${a}/${b}`, pipelineFlag]),
]);

export function isLivekitPipelineModelId(modelId: string): boolean {
  return livekitModelIdFlags[modelId]?.voiceStack === "pipeline";
}

/**
 * Shape expected by `lib/handlers/handler.js` for GET /models: each entry is
 * [`${vendor}/${name}`, description, flags].
 */
export function buildLivekitHandlerAllModels() {
  return [
    ...LIVEKIT_REALTIME_MODEL_ROWS.map((r) => {
      const [vendor, name, description] = r;
      return [`${vendor}/${name}`, description, realtimeFlag] as const;
    }),
    ...LIVEKIT_PIPELINE_MODEL_ROWS.map((r) => {
      const [vendor, name, description] = r;
      return [`${vendor}/${name}`, description, pipelineFlag] as const;
    }),
  ];
}
