/**
 * When `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS` is set, the voice pipeline uses
 * provider plugins and your API keys (Deepgram, OpenAI, Google, ElevenLabs, Cartesia)
 * instead of LiveKit Inference (`inference.*` + agent-gateway).
 */
import type { llm, stt, tts } from "@livekit/agents";
import * as cartesia from "@livekit/agents-plugin-cartesia";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as google from "@livekit/agents-plugin-google";
import * as openai from "@livekit/agents-plugin-openai";
import type { Agent } from "./api-client.js";
import {
  inferTtsVendor,
  langToSttSuffix,
  resolvePipelineStt,
  resolvePipelineTts,
} from "./pipeline-inference-options.js";

function truthyEnv(v: string | undefined): boolean {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/** Use `@livekit/agents-plugin-*` + env API keys instead of LiveKit Inference for the STT–LLM–TTS pipeline. */
export function pipelineUsesProviderApiKeys(): boolean {
  return truthyEnv(process.env.LIVEKIT_PIPELINE_USE_PROVIDER_KEYS);
}

function deepgramSttLanguage(agent: Agent): string {
  const raw = agent.options?.stt?.language?.trim();
  if (!raw) return "en-US";
  const norm = raw.replace("_", "-");
  if (/^[a-z]{2}-[a-z]{2}$/i.test(norm)) return norm;
  const primary = langToSttSuffix(raw);
  return primary === "en" ? "en-US" : primary;
}

function parseDeepgramStt(agent: Agent): { model: string; language: string } {
  const configured = resolvePipelineStt(agent);
  const m = /^deepgram\/([^:]+):(.+)$/.exec(configured);
  if (!m) {
    throw new Error(
      `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: STT must be Deepgram (got "${configured}"). Set options.stt.vendor to "deepgram" or options.pipeline.stt to deepgram/...`,
    );
  }
  return { model: m[1]!, language: deepgramSttLanguage(agent) };
}

export function buildProviderPipelineStt(agent: Agent): stt.STT {
  const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: DEEPGRAM_API_KEY is missing or empty (set it in the environment or .env loaded before the agent runs).",
    );
  }
  const { model, language } = parseDeepgramStt(agent);
  // Pass apiKey at construct time: the Deepgram plugin snapshots env in its module defaults when first imported.
  return new deepgram.STT({
    apiKey,
    model: model as never,
    language,
    detectLanguage: false,
  });
}

function parseLivekitModelName(modelName: string): { plugin: string; modelId: string } {
  const m = modelName.match(/^livekit:([^/]+)\/(.+)$/);
  if (!m) {
    throw new Error(
      `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: expected modelName livekit:<plugin>/<model> (got "${modelName}")`,
    );
  }
  return { plugin: m[1]!.toLowerCase(), modelId: m[2]! };
}

export function buildProviderPipelineLlm(
  agent: Agent,
  modelName: string,
): llm.LLM {
  const { plugin, modelId } = parseLivekitModelName(modelName);
  const temperature =
    typeof agent.options?.temperature === "number"
      ? agent.options.temperature
      : undefined;

  if (plugin === "google") {
    return new google.LLM({
      model: modelId,
      temperature,
      vertexai: process.env.GOOGLE_GENAI_USE_VERTEXAI === "true",
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION,
    });
  }
  if (plugin === "openai") {
    return new openai.LLM({
      model: modelId,
      temperature,
      strictToolSchema: false,
    });
  }
  throw new Error(
    `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: unsupported LLM plugin "${plugin}" in ${modelName}. Use livekit:google/... or livekit:openai/...`,
  );
}

function ttsPrimaryLanguage(agent: Agent): string | undefined {
  const t = agent.options?.tts?.language?.trim();
  if (t) return t.split("-")[0]!.toLowerCase();
  return langToSttSuffix(agent.options?.stt?.language);
}

function deepgramAuraModelFromSuffix(suffix: string): string {
  const s = suffix.trim().toLowerCase();
  if (!s) return "aura-asteria-en";
  if (s.startsWith("aura-")) return s;
  return `aura-${s}-en`;
}

function buildDeepgramPluginTtsFromAuraDescriptor(descriptor: string): tts.TTS {
  const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: DEEPGRAM_API_KEY is required for Deepgram TTS (aura).",
    );
  }
  const idx = descriptor.lastIndexOf(":");
  const voice = idx === -1 ? "" : descriptor.slice(idx + 1);
  return new deepgram.TTS({
    apiKey,
    model: deepgramAuraModelFromSuffix(voice),
  });
}

function cartesiaLanguage(agent: Agent): string {
  const p = ttsPrimaryLanguage(agent) || "en";
  const allowed = new Set([
    "en",
    "es",
    "fr",
    "de",
    "pt",
    "zh",
    "ja",
  ]);
  return allowed.has(p) ? p : "en";
}

/**
 * Direct-provider TTS (ElevenLabs, Cartesia, Deepgram Aura). Google Gemini TTS is handled separately in `voice-session-factory`.
 */
export function buildProviderPipelineTts(
  agent: Agent,
  opts: { pipelineTtsOverride: string },
): tts.TTS {
  const pipelineOverride = opts.pipelineTtsOverride.trim();
  if (pipelineOverride.startsWith("deepgram/aura-2:")) {
    return buildDeepgramPluginTtsFromAuraDescriptor(pipelineOverride);
  }

  const t = agent.options?.tts;
  const vendor = (t?.vendor || (t?.voice ? inferTtsVendor(t.voice) : "")).toLowerCase();

  if (vendor === "elevenlabs") {
    const voiceRaw = String(t?.voice || "").trim();
    const id = voiceRaw.includes(":")
      ? voiceRaw.split(":").pop()!.trim()
      : voiceRaw;
    const model =
      process.env.LIVEKIT_PIPELINE_ELEVENLABS_MODEL?.trim() || "eleven_turbo_v2_5";
    return new elevenlabs.TTS({
      voiceId: id,
      model: model as never,
      language: ttsPrimaryLanguage(agent),
    });
  }
  if (vendor === "cartesia") {
    const voiceRaw = String(t?.voice || "").trim();
    const id = voiceRaw.includes(":")
      ? voiceRaw.split(":").pop()!.trim()
      : voiceRaw;
    const model =
      process.env.LIVEKIT_PIPELINE_CARTESIA_TTS_MODEL?.trim() || "sonic-3";
    return new cartesia.TTS({
      voice: id,
      model,
      language: cartesiaLanguage(agent),
    });
  }
  if (vendor === "deepgram") {
    const ttsStr = resolvePipelineTts(agent);
    if (ttsStr.startsWith("deepgram/aura-2:")) {
      return buildDeepgramPluginTtsFromAuraDescriptor(ttsStr);
    }
    throw new Error(
      `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: Deepgram TTS expects options.pipeline.tts or voice config to resolve to deepgram/aura-2:... (got "${ttsStr}")`,
    );
  }

  throw new Error(
    `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: TTS vendor "${vendor || "unknown"}" is not supported for direct API keys. Use elevenlabs, cartesia, deepgram (aura-2), or google (Gemini TTS path).`,
  );
}
