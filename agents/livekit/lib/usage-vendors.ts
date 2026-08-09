/**
 * Canonical per-technology billing vendor/model for usage metering.
 *
 * The LiveKit usage metrics label is vendor-blind on the default Inference path
 * (everything is "inference.LLM"/"inference.TTS"/"inference.STT"), so deriving a
 * provider from the metric label loses the real vendor. This resolves the
 * authoritative `{vendor, detail}` from the *configured* services instead:
 *   - LLM  vendor = the `livekit:<plugin>/...` segment of the model name;
 *   - TTS/STT vendor+model from the configured pipeline service strings
 *     (`resolvePipelineTts` / `resolvePipelineStt`).
 *
 * Kept SDK-free (only the type-only `Agent` import + the SDK-free
 * pipeline-inference-options) so it is unit-testable without the LiveKit runtime.
 */
import type { Agent } from "./api-client.js";
import { resolvePipelineStt, resolvePipelineTts } from "./pipeline-inference-options.js";

export interface VendorDetail {
  vendor?: string;
  detail?: string;
}

export interface UsageVendors {
  llm: VendorDetail;
  tts: VendorDetail;
  stt: VendorDetail;
}

/** Split a "vendor/model:suffix" service string into {vendor, detail="vendor/model"}. */
function fromServiceString(s: string | undefined): VendorDetail {
  if (!s) return {};
  const head = s.split(":")[0]!; // strip any :lang / :voice suffix
  const vendor = head.split("/")[0]!.trim().toLowerCase() || undefined;
  return { vendor, detail: head || undefined };
}

/**
 * Resolve the canonical billing `{vendor, detail}` per priced technology. TTS/STT
 * resolution is wrapped so an env-gated vendor (e.g. google TTS) degrades to an
 * empty mapping rather than throwing — the caller then falls back to the SDK
 * label. Realtime agents bundle STT+TTS so those meters never fire; resolving
 * their pipeline defaults is harmless.
 */
export function resolveUsageVendors(agent: Agent, modelName: string): UsageVendors {
  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  // LLM: "livekit:<plugin>/<model>" -> vendor=<plugin>, detail="<plugin>/<model>".
  const m = /^livekit:([^/]+)\/(.+)$/.exec(modelName || "");
  const llm: VendorDetail = m
    ? { vendor: m[1]!.toLowerCase(), detail: `${m[1]!.toLowerCase()}/${m[2]}` }
    : {};
  const tts = safe(() => fromServiceString(resolvePipelineTts(agent))) || {};
  const stt = safe(() => fromServiceString(resolvePipelineStt(agent))) || {};
  return { llm, tts, stt };
}
