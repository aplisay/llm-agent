/**
 * Which route each voice pipeline stage takes: a provider plugin on our own key
 * ("direct"), or LiveKit Inference.
 *
 * Provider keys off: every stage is on Inference. Provider keys on: a stage goes
 * direct when a plugin can build it and its key is set, and any other stage falls
 * back to Inference. See docs/livekit-agent-architecture.md, 4.4.1.
 */
import { inference } from "@livekit/agents";
import type { llm, stt } from "@livekit/agents";
import type { Agent } from "./api-client.js";
import logger from "./logger.js";
import {
  pipelineTtsVendor,
  pipelineUsesGoogleTts,
  resolvePipelineStt,
  resolvePipelineTts,
} from "./pipeline-inference-options.js";
import {
  buildProviderPipelineLlm,
  buildProviderPipelineStt,
  pipelineUsesProviderApiKeys,
  providerLlmKey,
  providerSttKey,
  providerTtsKey,
} from "./pipeline-provider-keys.js";
import { fromServiceString } from "./usage-vendors.js";

export type PipelineRoute = "direct" | "inference";

export interface StageRoute {
  /** `stt`, `llm`, `tts`, or a side engine such as `aux-stt`. */
  stage: string;
  /** The configured vendor, as usage metering names it. Never `inference`. */
  vendor: string;
  route: PipelineRoute;
  /** Provider keys are on, and this stage runs on Inference all the same. */
  fallback: boolean;
  /** The vendor has a plugin, but this variable is not set. */
  missingKey?: string;
}

/** `key` is the variable the direct builder needs, or undefined when no plugin builds the stage. */
function decide(stage: string, vendor: string, key: string | undefined): StageRoute {
  if (!pipelineUsesProviderApiKeys()) {
    return { stage, vendor, route: "inference", fallback: false };
  }
  if (key !== undefined && process.env[key]?.trim()) {
    return { stage, vendor, route: "direct", fallback: false };
  }
  return { stage, vendor, route: "inference", fallback: true, ...(key ? { missingKey: key } : {}) };
}

function serviceVendor(resolve: () => string): string {
  try {
    return fromServiceString(resolve()).vendor ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function pipelineSttRoute(agent: Agent, stage = "stt"): StageRoute {
  return decide(stage, serviceVendor(() => resolvePipelineStt(agent)), providerSttKey(agent));
}

export function pipelineLlmRoute(modelName: string): StageRoute {
  const stage = "llm";
  const vendor = /^livekit:([^/]+)\/.+$/.exec(modelName)?.[1]?.toLowerCase();
  if (!vendor) {
    // No vendor to route. Under provider keys the direct builder reports the malformed name.
    const route = pipelineUsesProviderApiKeys() ? "direct" : "inference";
    return { stage, vendor: "unknown", route, fallback: false };
  }
  return decide(stage, vendor, providerLlmKey(modelName));
}

export function pipelineTtsRoute(agent: Agent): StageRoute {
  const stage = "tts";
  // buildPipelineTts sends these two direct whatever the settings say.
  if (pipelineTtsVendor(agent) === "neuphonic") {
    return { stage, vendor: "neuphonic", route: "direct", fallback: false };
  }
  if (pipelineUsesGoogleTts(agent)) {
    // LIVEKIT_PIPELINE_GOOGLE_TTS names an Inference model to use in place of Gemini TTS.
    const route = process.env.LIVEKIT_PIPELINE_GOOGLE_TTS?.trim() ? "inference" : "direct";
    return { stage, vendor: "google", route, fallback: false };
  }
  return decide(stage, serviceVendor(() => resolvePipelineTts(agent)), providerTtsKey(agent));
}

/** Log the route of each stage about to be built. Call it once per session or side engine. */
export function logPipelineRoutes(routes: StageRoute[], agent?: Agent): void {
  const agentId = agent?.id;
  logger.info(
    { agentId, routes: routes.map(({ stage, vendor, route }) => ({ stage, vendor, route })) },
    `pipeline routes: ${routes.map((r) => `${r.stage} ${r.vendor} ${r.route}`).join(", ")}`,
  );
  for (const { stage, vendor, missingKey } of routes) {
    if (!missingKey) continue;
    logger.warn(
      { agentId, stage, vendor, missingKey },
      `pipeline ${stage}: ${missingKey} is not set, so ${vendor} runs on LiveKit Inference and is billed to the LiveKit project`,
    );
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type ErrorSource = { on(event: "error", listener: (ev: any) => void): unknown };

/**
 * Build a stage on Inference. A fallback stage passes its configured model as it is, and
 * Inference may not offer it, so a failure there names the stage, the vendor and the route.
 */
export function buildOnInference<T>(route: StageRoute, model: string, build: () => T): T {
  if (!route.fallback) return build();
  const { stage, vendor } = route;
  const where = `pipeline ${stage}: vendor "${vendor}" on LiveKit Inference (${model})`;
  let built: T;
  try {
    built = build();
  } catch (e) {
    throw new Error(`${where} could not be built: ${errorText(e)}`);
  }
  (built as ErrorSource).on("error", (ev) => {
    const recoverable = ev?.recoverable !== false;
    logger[recoverable ? "warn" : "error"](
      { stage, vendor, route: "inference", model, recoverable },
      `${where} failed: ${errorText(ev?.error)}`,
    );
  });
  return built;
}

export function buildPipelineStt(agent: Agent, route: StageRoute): stt.STT {
  if (route.route === "direct") return buildProviderPipelineStt(agent);
  const model = resolvePipelineStt(agent);
  // What AgentSession does with a string `stt`.
  return buildOnInference(route, model, () => inference.STT.fromModelString(model));
}

export function buildPipelineLlm(agent: Agent, modelName: string, route: StageRoute): llm.LLM {
  if (route.route === "direct") return buildProviderPipelineLlm(agent, modelName);
  const m = /^livekit:([^/]+)\/(.+)$/.exec(modelName);
  // Inference ids carry the vendor prefix, so a fallback sends it. With provider keys off
  // the worker has always sent the bare model id, and that path is left as it was.
  const model =
    route.fallback && m
      ? `${m[1]!.toLowerCase()}/${m[2]}`
      : m?.[2] || process.env.LIVEKIT_PIPELINE_LLM || "openai/gpt-4o-mini";
  return buildOnInference(route, model, () => new inference.LLM({ model }));
}

/** An STT outside an AgentSession (auxiliary, output audit, bridged call), routed as the pipeline STT is. */
export function buildStandaloneStt(agent: Agent, stage: string): stt.STT {
  const route = pipelineSttRoute(agent, stage);
  logPipelineRoutes([route], agent);
  return buildPipelineStt(agent, route);
}
