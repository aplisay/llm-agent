/**
 * VENDORED COPY — jambonz-agent image only. Not used in local dev.
 *
 * The shared `lib/models/livekit.js` (copied into this image as
 * `agent-lib/models/livekit.js`) statically imports this registry from
 * `../../agents/livekit/dist/lib/livekit-model-registry.js` — the LiveKit agent's
 * *compiled* output, which is not part of the jambonz image. The jambonz
 * Dockerfile copies this file to that exact path so the import resolves and
 * `agent-lib/models/livekit.js` can stay byte-identical to the shared lib.
 *
 * This is a stopgap. The real fix is to make `lib/models/livekit.js`
 * self-contained (the way `lib/models/pipecat.js` already is), removing the
 * shared-lib → agent-dist coupling. Tracked in aplisay/llm-agent#123.
 *
 * KEEP IN SYNC with `agents/livekit/lib/livekit-model-registry.ts` (model rows
 * + flags). Only the three symbols imported by `lib/models/livekit.js` are
 * required here: `livekitModelIdFlags`, `isLivekitPipelineModelId`,
 * `buildLivekitHandlerAllModels`.
 */

/** Speech-to-speech (builtin STT/TTS in the realtime model). */
const LIVEKIT_REALTIME_MODEL_ROWS = [
  ["openai", "gpt-realtime", "OpenAI (Livekit realtime)"],
  ["ultravox", "ultravox-70b", "Ultravox 70B (Livekit realtime)"],
  ["ultravox", "ultravox-v0.6", "Ultravox 0.6 (Livekit realtime)"],
  ["ultravox", "ultravox-v0.6-gemma3-27b", "Ultravox 0.6 (Livekit realtime)"],
  ["ultravox", "ultravox-v0.7", "Ultravox 0.7 (GLM 4.6) (Livekit realtime)"],
  ["google", "gemini-2.0-flash-exp", "Google Gemini 2.0 (Livekit realtime)"],
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
