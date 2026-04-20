/**
 * Pipeline model ids (segment after `livekit:` in modelName).
 * Keep in sync with PIPELINE_MODEL_ROWS in /lib/models/livekit.js.
 */
const PIPELINE_MODEL_IDS = new Set<string>([
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "openai/gpt-5-mini",
  "google/gemini-2.5-flash",
  "google/gemini-2.0-flash",
]);

export function isLivekitPipelineModelId(modelId: string): boolean {
  return PIPELINE_MODEL_IDS.has(modelId);
}
