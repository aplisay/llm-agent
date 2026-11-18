/**
 * Canonical per-technology billing vendor/model for usage metering.
 *
 * The LiveKit usage metrics label is vendor-blind on the default Inference path
 * (everything is "inference.LLM"/"inference.TTS"/"inference.STT"), so deriving a
 * provider from the metric label loses the real vendor. This resolves the
 * authoritative `{vendor, detail}` from the *configured* services instead:
 *   - LLM  vendor = the `livekit:<plugin>/...` segment of the model name;
 *   - TTS/STT vendor+model from the route the stage takes (pipeline-routing.ts):
 *     the Inference model string, or the model the provider plugin is given.
 *     A rate card prices these rows by their exact `detail`, so it must name
 *     the model that ran.
 */
import type { Agent } from "./api-client.js";
import {
  fromServiceString,
  geminiTtsModel,
  resolvePipelineStt,
  resolvePipelineTts,
  type VendorDetail,
} from "./pipeline-inference-options.js";
import { providerSttModel, providerTtsModel } from "./pipeline-provider-keys.js";
import { pipelineSttRoute, pipelineTtsRoute } from "./pipeline-routing.js";

export { fromServiceString, type VendorDetail };

export interface UsageVendors {
  llm: VendorDetail;
  tts: VendorDetail;
  stt: VendorDetail;
}

/**
 * Deepgram prices `language=multi` apart from one language, so the row says which ran.
 * Keep in step with MULTILINGUAL_SUFFIX in agents/pipecat/pipecat_aplisay/usage.py.
 */
export const MULTILINGUAL_SUFFIX = "-multilingual";

function sttDetail(vendor: string | undefined, model: string | undefined, language: string | undefined) {
  const multilingual = vendor === "deepgram" && language?.trim().toLowerCase() === "multi";
  return model && multilingual ? `${model}${MULTILINGUAL_SUFFIX}` : model;
}

/**
 * `{vendor, detail}` for the rows of this agent's STT, or of a side engine's stand-in agent.
 * The two routes can run different languages for one agent: the plugin ignores a `:lang` suffix.
 */
export function sttUsageVendor(agent: Agent): VendorDetail {
  if (pipelineSttRoute(agent).route === "direct") {
    const { model, language } = providerSttModel(agent);
    return { vendor: "deepgram", detail: sttDetail("deepgram", `deepgram/${model}`, language) };
  }
  const configured = resolvePipelineStt(agent);
  const { vendor, detail } = fromServiceString(configured);
  return { vendor, detail: sttDetail(vendor, detail, configured.split(":")[1]) };
}

/** `{vendor, detail}` for the rows of this agent's TTS. */
export function ttsUsageVendor(agent: Agent): VendorDetail {
  const route = pipelineTtsRoute(agent);
  if (route.route === "direct") {
    // Gemini TTS has no Inference id: resolvePipelineTts throws for it.
    if (route.vendor === "google") return { vendor: "google", detail: `google/${geminiTtsModel()}` };
    const ran = route.vendor === "neuphonic" ? undefined : providerTtsModel(agent);
    if (ran) {
      // Aura-2 is one model on both routes, so its rows keep the Inference id. An Aura-1 voice is its own model.
      const aura2 = ran.vendor === "deepgram" && ran.model.startsWith("aura-2-");
      return { vendor: ran.vendor, detail: aura2 ? "deepgram/aura-2" : `${ran.vendor}/${ran.model}` };
    }
  }
  return fromServiceString(resolvePipelineTts(agent));
}

/**
 * Resolve the canonical billing `{vendor, detail}` per priced technology. TTS/STT
 * resolution is wrapped so a resolver that throws degrades to an empty mapping:
 * the caller then falls back to the SDK label. Realtime agents bundle STT+TTS so
 * those meters never fire; resolving their pipeline defaults is harmless.
 *
 * `llmBackend` replaces the model's own `llm` entry: GPT-Live's tokens are its
 * backend model's (gpt-live-model.ts), not `openai/gpt-live-1`'s.
 */
export function resolveUsageVendors(
  agent: Agent,
  modelName: string,
  { llmBackend }: { llmBackend?: VendorDetail } = {},
): UsageVendors {
  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  // LLM: "livekit:<plugin>/<model>" -> vendor=<plugin>, detail="<plugin>/<model>".
  const m = /^livekit:([^/]+)\/(.+)$/.exec(modelName || "");
  const llm: VendorDetail = llmBackend
    ? llmBackend
    : m
      ? { vendor: m[1]!.toLowerCase(), detail: `${m[1]!.toLowerCase()}/${m[2]}` }
      : {};
  const tts = safe(() => ttsUsageVendor(agent)) || {};
  const stt = safe(() => sttUsageVendor(agent)) || {};
  return { llm, tts, stt };
}
