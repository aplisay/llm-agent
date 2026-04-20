/**
 * Derives LiveKit Inference STT / TTS model strings from agent options (API shape).
 * `options.pipeline.*` overrides when set.
 */
import type { Agent } from "./api-client.js";

/**
 * Keep in sync with `lib/deepgram-livekit-inference-voice.js` (TS rootDir cannot import repo `lib/`).
 * @see https://docs.livekit.io/agents/models/tts/inference/deepgram/
 */
function deepgramCatalogToInferenceVoice(voiceId: string): string {
  const id = String(voiceId || "").trim();
  if (!id) return id;
  const m = /^aura-([a-z0-9]+)-[a-z]{2}(?:-[a-z]{2})?$/i.exec(id);
  if (m) return m[1]!.toLowerCase();
  return id.toLowerCase();
}

/**
 * UI / legacy values that mean "no fixed language" but are not valid Inference
 * provider language tags (Deepgram rejects e.g. `any`).
 */
const NON_SPECIFIC_STT_LANGUAGES = new Set([
  "any",
  "multi",
  "*",
  "auto",
  "all",
  "global",
]);

/** Primary language tag for Deepgram-style STT (e.g. `en` from `en-GB`). */
export function langToSttSuffix(language?: string): string {
  const fallback = process.env.LIVEKIT_PIPELINE_STT_LANG || "en";
  if (language == null || !String(language).trim()) return fallback;
  const primary = String(language).trim().split("-")[0]!.toLowerCase();
  if (!primary || NON_SPECIFIC_STT_LANGUAGES.has(primary)) return fallback;
  return primary;
}

function defaultPipelineEnv(): { stt: string; tts: string } {
  return {
    stt: process.env.LIVEKIT_PIPELINE_STT ?? "deepgram/nova-3:general",
    tts:
      process.env.LIVEKIT_PIPELINE_TTS ??
      "cartesia/sonic-3:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
  };
}

/**
 * STT inference id, e.g. `deepgram/nova-3:en`
 */
export function resolvePipelineStt(agent: Agent): string {
  const o = agent.options?.pipeline?.stt;
  if (o) return o;

  const stt = agent.options?.stt;
  const vendor = (stt?.vendor || "deepgram").toLowerCase();
  const lang = langToSttSuffix(stt?.language);

  if (vendor === "assemblyai") {
    return `assemblyai/universal-streaming:${lang}`;
  }
  if (vendor === "cartesia") {
    return `cartesia/ink-whisper:${lang}`;
  }
  // deepgram (default)
  return `deepgram/nova-3:${lang}`;
}

/**
 * TTS inference id, e.g. `cartesia/sonic-3:<voice-uuid>`
 */
export function resolvePipelineTts(agent: Agent): string {
  const o = agent.options?.pipeline?.tts;
  if (o) return o;

  const t = agent.options?.tts;
  const env = defaultPipelineEnv();

  if (!t?.voice) {
    return env.tts;
  }

  const voice = String(t.voice).trim();
  const vendor = (t.vendor || inferTtsVendor(voice)).toLowerCase();

  // Ultravox is used via the realtime plugin, not as an Inference TTS endpoint.
  if (vendor === "ultravox") {
    return env.tts;
  }

  if (vendor === "cartesia") {
    const id = voice.includes(":") ? voice.split(":").pop()!.trim() : voice;
    return `cartesia/sonic-3:${id}`;
  }
  if (vendor === "elevenlabs") {
    const id = voice.includes(":") ? voice.split(":").pop()!.trim() : voice;
    return `elevenlabs/eleven_turbo_v2_5:${id}`;
  }
  if (vendor === "deepgram") {
    const id = voice.includes(":") ? voice.split(":").pop()!.trim() : voice;
    return `deepgram/aura-2:${deepgramCatalogToInferenceVoice(id)}`;
  }
  if (vendor === "google") {
    const full = process.env.LIVEKIT_PIPELINE_GOOGLE_TTS;
    if (full) {
      return full.includes("{voice}") ? full.replace("{voice}", voice) : full;
    }
    throw new Error(
      "resolvePipelineTts: vendor google requires LIVEKIT_PIPELINE_GOOGLE_TTS, or use voice-session-factory Gemini TTS path",
    );
  }

  return env.tts;
}

export function inferTtsVendor(voice: string): string {
  if (/^[a-f0-9-]{8,}$/i.test(voice)) {
    return "cartesia";
  }
  // Google Cloud TTS catalogue ids (e.g. en-GB-Standard-O, en-US-Wavenet-A, nl-NL-Neural2-E).
  if (
    /Standard|Wavenet|Neural2|Neural|Chirp|Studio|Polyglot|Journey|News|Casual/i.test(voice)
  ) {
    return "google";
  }
  if (voice.includes(":")) {
    const [v] = voice.split(":");
    if (["cartesia", "elevenlabs", "google", "deepgram"].includes(v.toLowerCase())) {
      return v.toLowerCase();
    }
  }
  return "cartesia";
}

/**
 * LLM inference id for pipeline (defaults to model id from `livekit:provider/modelId`).
 */
export function resolvePipelineLlm(
  agent: Agent,
  providerModelSegment: string | undefined,
): string {
  const o = agent.options?.pipeline?.llm;
  if (o) return o;
  if (providerModelSegment) return providerModelSegment;
  return process.env.LIVEKIT_PIPELINE_LLM ?? "openai/gpt-4o-mini";
}
