import type { Agent } from "./api-client.js";
import { isLivekitPipelineModelId } from "./livekit-pipeline-model-ids.js";

/**
 * How the voice stack is composed: single realtime speech-to-speech model vs
 * STT–LLM–TTS pipeline (LiveKit Inference or plugins).
 */
export type VoiceMode = "realtime" | "pipeline";

/** Segment after `livekit:` in modelName (e.g. `openai/gpt-4o-mini`). */
export function livekitModelIdFromName(modelName: string): string {
  return modelName.startsWith("livekit:")
    ? modelName.slice("livekit:".length)
    : modelName;
}

/**
 * Pipeline vs realtime: driven by the model id from GET /models (`livekit:…`), with optional
 * `options.voiceMode` override. Pipeline model ids match `livekit-pipeline-model-ids.ts`
 * (keep in sync with `lib/models/livekit.js` PIPELINE_MODEL_ROWS).
 */
export function resolveVoiceMode(
  modelName: string,
  options?: Agent["options"] | null,
): VoiceMode {
  if (options?.voiceMode === "pipeline") return "pipeline";
  if (options?.voiceMode === "realtime") return "realtime";
  const id = livekitModelIdFromName(modelName);
  if (isLivekitPipelineModelId(id)) return "pipeline";
  return "realtime";
}
