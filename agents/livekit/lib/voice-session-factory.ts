/**
 * Constructs {@link voice.Agent} + {@link voice.AgentSession} for realtime (speech-to-speech)
 * or STT–LLM–TTS pipeline (LiveKit Inference), per LiveKit Agents patterns.
 */
import { inference, voice, type llm } from "@livekit/agents";
import type { VAD } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as google from "@livekit/agents-plugin-google";
import * as ultravox from "../plugins/ultravox/src/index.js";
import type { Agent, Call } from "./api-client.js";
import type { VoiceMode } from "./voice-mode.js";
import {
  inferTtsVendor,
  resolvePipelineStt,
  resolvePipelineTts,
} from "./pipeline-inference-options.js";
import {
  buildProviderPipelineLlm,
  buildProviderPipelineStt,
  buildProviderPipelineTts,
  pipelineUsesProviderApiKeys,
} from "./pipeline-provider-keys.js";

/**
 * Google Cloud voice ids (e.g. en-GB-Wavenet-N) are not LiveKit Inference models.
 * Node agents use Gemini TTS (`@livekit/agents-plugin-google` beta); map Cloud ids to a Gemini prebuilt voice.
 */
function geminiVoiceNameForGoogleTtsOption(agent: Agent): string {
  const explicit = agent.options?.vendorSpecific?.google?.geminiVoiceName?.trim();
  if (explicit) return explicit;

  const fromEnv = process.env.LIVEKIT_PIPELINE_GEMINI_TTS_VOICE?.trim();
  if (fromEnv) return fromEnv;

  const v = String(agent.options?.tts?.voice || "").trim();
  if (/^[A-Za-z]+$/.test(v)) {
    return v;
  }

  const cloud = /^([a-z]{2})-([a-z]{2})-/i.exec(v);
  if (cloud) {
    const perLocale = process.env[
      `LIVEKIT_PIPELINE_GEMINI_TTS_VOICE_${cloud[1]!.toUpperCase()}_${cloud[2]!.toUpperCase()}`
    ]?.trim();
    if (perLocale) return perLocale;
  }

  return "Kore";
}

function inferenceTtsForDeepgramAura2(ttsStr: string, agent: Agent) {
  const idx = ttsStr.lastIndexOf(":");
  const voice = ttsStr.slice(idx + 1);
  const language =
    agent.options?.tts?.language?.trim() ||
    agent.options?.stt?.language?.trim() ||
    undefined;
  return new inference.TTS({
    model: "deepgram/aura-2",
    voice,
    ...(language ? { language } : {}),
  });
}

/** LiveKit Inference TTS model string, Deepgram `inference.TTS`, or Google Gemini TTS plugin. */
function buildPipelineTts(agent: Agent) {
  const useKeys = pipelineUsesProviderApiKeys();

  const t = agent.options?.tts;
  const vendor = (t?.vendor || (t?.voice ? inferTtsVendor(t.voice) : "")).toLowerCase();

  if (vendor === "google") {
    const custom = process.env.LIVEKIT_PIPELINE_GOOGLE_TTS?.trim();
    if (custom) {
      const voice = String(t?.voice || "").trim();
      return custom.includes("{voice}") ? custom.replace("{voice}", voice) : custom;
    }
    const model =
      process.env.LIVEKIT_PIPELINE_GEMINI_TTS_MODEL?.trim() || "gemini-2.5-flash-preview-tts";
    return new google.beta.TTS({
      model,
      voiceName: geminiVoiceNameForGoogleTtsOption(agent),
      vertexai: process.env.GOOGLE_GENAI_USE_VERTEXAI === "true",
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION,
    });
  }

  if (useKeys) {
    return buildProviderPipelineTts(agent);
  }

  const ttsStr = resolvePipelineTts(agent);
  if (ttsStr.startsWith("deepgram/aura-2:")) {
    return inferenceTtsForDeepgramAura2(ttsStr, agent);
  }
  return ttsStr;
}

export const realtimePluginModules: Record<string, unknown> = {
  openai,
  ultravox,
  google,
};

export function getRealtimePlugin(modelName: string): {
  plugin: string | undefined;
  realtime:
    | { RealtimeModel: new (opts: Record<string, unknown>) => llm.RealtimeModel }
    | undefined;
} {
  const plugin = modelName.match(/livekit:(\w+)\//)?.[1];
  const mod = plugin ? realtimePluginModules[plugin] : undefined;
  const realtime = mod as
    | { realtime?: { RealtimeModel: new (opts: Record<string, unknown>) => llm.RealtimeModel } }
    | undefined;
  return { plugin, realtime: realtime?.realtime };
}

/** Provider segment after `livekit:<plugin>/` (e.g. gpt-4o, fixie-ai/ultravox-70B). */
export function parseProviderModelName(modelName: string): string | undefined {
  const m = modelName.match(/^livekit:[^/]+\/(.+)$/);
  return m ? m[1] : undefined;
}

const PIPELINE_ON_ENTER_REPLY_INSTRUCTIONS =
  "greet the user according to the instructions in your system prompt.";

/**
 * STT–LLM–TTS does not speak until user input unless we seed a first turn
 * (see https://docs.livekit.io/agents/logic/nodes.md — onEnter + generateReply).
 */
class PipelineVoiceAgent extends voice.Agent {
  async onEnter(): Promise<void> {
    // Greeting is handled centrally in runAgentWorker so it can be made uninterruptible
    // and consistent with realtime stacks. Keep this hook empty.
  }
}

export interface CreateVoiceModelAndSessionParams {
  voiceMode: VoiceMode;
  modelName: string;
  agent: Agent;
  call: Call;
  tools: llm.ToolContext;
  /** Required for pipeline mode (Silero VAD from prewarm). */
  vad?: VAD;
}

export function createVoiceModelAndSession(
  params: CreateVoiceModelAndSessionParams,
): { session: voice.AgentSession; model: voice.Agent } {
  const { voiceMode, modelName, agent, call, tools, vad } = params;

  const agentOptions = {
    instructions: agent?.prompt || "You are a helpful assistant.",
    tools,
  };

  const model =
    voiceMode === "pipeline"
      ? new PipelineVoiceAgent(agentOptions)
      : new voice.Agent(agentOptions);

  if (voiceMode === "pipeline") {
    const providerSeg = parseProviderModelName(modelName);
    const useProviderKeys = pipelineUsesProviderApiKeys();
    const sttModel = useProviderKeys
      ? buildProviderPipelineStt(agent)
      : resolvePipelineStt(agent);
    const pipelineLlm = useProviderKeys
      ? buildProviderPipelineLlm(agent, modelName)
      : new inference.LLM({
          model: providerSeg || process.env.LIVEKIT_PIPELINE_LLM || "openai/gpt-4o-mini",
        });
    const ttsModel = buildPipelineTts(agent);

    // Prefer Silero VAD + vad turn detection when `proc.userData.vad` is set (optional prewarm);
    // otherwise use STT-based turn detection (no extra native deps).
    const session = new voice.AgentSession({
      ...(vad
        ? { vad, turnDetection: "vad" as const }
        : { turnDetection: "stt" as const }),
      // Drop early user audio while agent speech is uninterruptible (greeting mode).
      // This matches the product decision to avoid buffering/replaying early speech.
      turnHandling: {
        interruption: {
          discardAudioIfUninterruptible: true,
        },
      },
      stt: sttModel,
      llm: pipelineLlm,
      tts: ttsModel,
    } as any);
    return { session, model };
  }

  const { realtime } = getRealtimePlugin(modelName);
  if (!realtime) {
    throw new Error(
      `Unsupported realtime model: ${modelName} (expected livekit:<openai|ultravox|google>/...)`,
    );
  }

  const providerModelName = parseProviderModelName(modelName);
  const maxDurationString: string = agent?.options?.maxDuration || "305s";
  const llmOptions: Record<string, unknown> = {
    voice: agent?.options?.tts?.voice,
    maxDuration: maxDurationString,
    instructions: agent?.prompt || "You are a helpful assistant.",
    callId: call.id,
  };
  if (providerModelName) {
    llmOptions.model = providerModelName;
  }
  const vendorSpecific = (agent?.options?.vendorSpecific ||
    undefined) as Record<string, any> | undefined;

  // Ultravox realtime: map portable `options.greeting` → provider-native firstSpeakerSettings
  // so the greeting actually happens at call start (Ultravox doesn't support response.create).
  if (modelName.includes("livekit:ultravox/")) {
    const greetingText = agent?.options?.greeting?.text?.trim() || "";
    const greetingInstructions = agent?.options?.greeting?.instructions?.trim() || "";
    const hasGreeting = Boolean(greetingText) || Boolean(greetingInstructions);

    const existingFirstSpeaker =
      vendorSpecific?.ultravox?.firstSpeakerSettings?.agent?.text ||
      vendorSpecific?.ultravox?.firstSpeakerSettings?.agent?.prompt ||
      vendorSpecific?.ultravox?.firstSpeakerSettings?.user;

    if (hasGreeting && !existingFirstSpeaker) {
      llmOptions.vendorSpecific = {
        ...(vendorSpecific || {}),
        ultravox: {
          ...(vendorSpecific?.ultravox || {}),
          firstSpeakerSettings: {
            agent: greetingText
              ? { uninterruptible: true, text: greetingText }
              : { uninterruptible: true, prompt: greetingInstructions },
          },
        },
      };
    } else if (vendorSpecific) {
      llmOptions.vendorSpecific = vendorSpecific;
    }
  } else if (vendorSpecific) {
    llmOptions.vendorSpecific = vendorSpecific;
  }

  const session = new voice.AgentSession({
    llm: new realtime.RealtimeModel(llmOptions),
    // Drop early user audio while agent speech is uninterruptible (greeting mode).
    turnHandling: {
      interruption: {
        discardAudioIfUninterruptible: true,
      },
    },
  } as any);
  return { session, model };
}
