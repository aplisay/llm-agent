/**
 * External TTS on a realtime model: the text-output rule (SDK-free).
 *
 * Section 4.3 of docs/livekit-agent-architecture.md: on a realtime
 * (speech-to-speech) model, `options.tts.vendor` set to a vendor other than the
 * model's own provider means the model runs in text-output mode and a discrete
 * TTS stage speaks its text. `options.tts.voice` and `options.tts.language` then
 * belong to that TTS.
 *
 * Same table as agents/pipecat/pipecat_aplisay/realtime_tts.py and the
 * `externalTts` row flag in livekit-model-registry.ts. Keep them in step.
 */
import type { Agent } from "./api-client.js";
import { isLivekitPipelineModelId } from "./livekit-model-registry.js";
import { livekitModelIdFromName } from "./voice-mode.js";

/**
 * The vendor name that means "the model's own voice" for each `livekit:<plugin>/`
 * segment. `google` is both a realtime provider and a TTS vendor, so on a Gemini
 * row it is native and everywhere else it is external.
 */
export const REALTIME_NATIVE_TTS_VENDORS: Record<string, string> = {
  ultravox: "ultravox",
  openai: "openai",
  google: "google",
};

/**
 * Plugins this worker can run in text-output mode. Gemini Live is absent on
 * purpose: no Live model the API still serves accepts a TEXT response modality
 * (checked 2026-09-10; the half-cascade models are gone and the native-audio
 * model rejects it). Must match the rows flagged `externalTts` in
 * livekit-model-registry.ts.
 */
export const TEXT_OUTPUT_PLUGINS: ReadonlySet<string> = new Set(["ultravox", "openai"]);

/** Plugin segment of a `livekit:<plugin>/<model>` name, lowercased. */
export function realtimePlugin(modelName: string): string {
  const m = /^livekit:([^/]+)\//.exec(modelName || "");
  return m ? m[1]!.toLowerCase() : "";
}

/**
 * `options.tts.vendor` normalised for comparison: lowercased, `/model` scoping
 * stripped (`elevenlabs/eleven_flash_v2_5` -> `elevenlabs`). Undefined when unset
 * or blank.
 */
export function ttsVendor(agent: Agent | null | undefined): string | undefined {
  const raw = agent?.options?.tts?.vendor;
  if (typeof raw !== "string") return undefined;
  const vendor = raw.trim().split("/")[0]!.trim().toLowerCase();
  return vendor || undefined;
}

/**
 * The external TTS vendor the agent asks for, or undefined when the agent should
 * use the model's own voice (vendor unset, or the provider's own). This is the
 * rule only; whether the plugin can honour it is {@link textOutputEnabled}.
 */
export function externalTtsVendor(agent: Agent | null | undefined, modelName: string): string | undefined {
  const vendor = ttsVendor(agent);
  if (!vendor) return undefined;
  const plugin = realtimePlugin(modelName);
  const native = REALTIME_NATIVE_TTS_VENDORS[plugin] ?? plugin;
  return vendor === native ? undefined : vendor;
}

/**
 * True when this session must run the realtime model in text-output mode with an
 * external TTS: the agent asks for one AND the plugin supports it on this worker.
 */
export function textOutputEnabled(agent: Agent | null | undefined, modelName: string): boolean {
  // A pipeline row's TTS is always a discrete stage; the rule is for realtime rows.
  if (isLivekitPipelineModelId(livekitModelIdFromName(modelName))) return false;
  if (!TEXT_OUTPUT_PLUGINS.has(realtimePlugin(modelName))) return false;
  return externalTtsVendor(agent, modelName) !== undefined;
}
