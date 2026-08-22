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

/**
 * Deprecated model ids kept RESOLVABLE for agents already saved on them, mapped
 * to the id they actually run as.
 *
 * `plugins/ultravox/src/realtime/realtime_model.ts` rewrites `ultravox-70b` to
 * `ultravox-v0.6` at session start ("Hack to catch all attempts to use a llama
 * 70b model"), so the alias has always *run*. But that mapping lived only in the
 * plugin, so the roster went on advertising `ultravox-70b` as an ordinary,
 * selectable model — which is how agents keep acquiring a name that is not an
 * Ultravox model at all, long after it was deprecated.
 *
 * Declaring the target here lets `buildLivekitHandlerAllModels` drop an alias
 * whose target is not offered, rather than advertise a name that resolves to
 * nothing. Resolution is unaffected either way: a saved agent finds its handler
 * by the `livekit:` PREFIX (`Handler.getHandler` → `Handler.parseName`), never
 * by looking its model up in this roster, so an unlisted alias still runs and
 * still passes the `Unknown model name` check on save.
 */
export const LIVEKIT_MODEL_ALIASES: Record<string, string> = {
  "ultravox/ultravox-70b": "ultravox/ultravox-v0.6",
};

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
  const rows = [
    ...LIVEKIT_REALTIME_MODEL_ROWS.map((r) => {
      const [vendor, name, description] = r;
      return [`${vendor}/${name}`, description, realtimeFlag] as const;
    }),
    ...LIVEKIT_PIPELINE_MODEL_ROWS.map((r) => {
      const [vendor, name, description] = r;
      return [`${vendor}/${name}`, description, pipelineFlag] as const;
    }),
  ];
  // An alias is only worth offering while the model it resolves to is itself
  // offered. Drop one whose target has gone, so retiring a model cannot leave
  // its alias behind advertising a session that could never start. Targets are
  // matched against the NON-alias rows, so an alias can never satisfy another
  // alias and a cycle cannot keep a dead pair alive.
  const offered = new Set(rows.map(([id]) => id).filter((id) => !(id in LIVEKIT_MODEL_ALIASES)));
  return rows.filter(([id]) => {
    const target = LIVEKIT_MODEL_ALIASES[id];
    return target === undefined || offered.has(target);
  });
}
