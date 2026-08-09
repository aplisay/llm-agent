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
import { promptWithMetadata } from "../agent-lib/prompt-metadata.js";
import type { VoiceMode } from "./voice-mode.js";
import {
  agentLanguageTag,
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
 * How many times the inactivity prompt is spoken before the call is considered
 * abandoned. Shared so the two enforcement paths agree: the Ultravox native
 * `inactivityMessages` list length, and our own repeat-kick counter in
 * voice-agent-runtime. Only acted on when `options.inactivity.hangup` is set —
 * otherwise Ultravox stops prompting after this many and we keep prompting.
 */
export const INACTIVITY_PROMPT_COUNT = 3;

/**
 * Whether `options.inactivity.hangup` opts this agent into ending the call once the
 * inactivity prompt has gone unanswered {@link INACTIVITY_PROMPT_COUNT} times.
 *
 * Only meaningful alongside a usable inactivity config, so it returns false whenever
 * {@link inactivityAwayTimeoutSecs} would return undefined — there is no prompt to
 * count, so there is nothing to hang up after.
 */
export function inactivityHangupEnabled(agent: Agent): boolean {
  if (inactivityAwayTimeoutSecs(agent) === undefined) return false;
  return agent?.options?.inactivity?.hangup === true;
}

/**
 * Parse the inactivity-kick idle timeout (`options.inactivity.timeout`) into
 * seconds for LiveKit's `voiceOptions.userAwayTimeout`. Accepts a number of
 * seconds or a string like `"8s"` (the same convention as `maxDuration`).
 *
 * Returns `undefined` when `options.inactivity` is absent or malformed (no
 * usable timeout, or no non-empty `message`). In that case the caller omits
 * `userAwayTimeout` entirely, so the session keeps the SDK default
 * (`15s`) but no kick handler is wired — behaviour is unchanged.
 */
export function inactivityAwayTimeoutSecs(agent: Agent): number | undefined {
  const inactivity = agent?.options?.inactivity;
  if (!inactivity || typeof inactivity !== "object") return undefined;
  const message = inactivity.message;
  if (typeof message !== "string" || !message.trim()) return undefined;

  const raw = inactivity.timeout;
  let secs: number | undefined;
  if (typeof raw === "number" && isFinite(raw)) {
    secs = raw;
  } else if (typeof raw === "string") {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)s?$/);
    if (m) secs = parseFloat(m[1]);
  }
  if (secs === undefined || !(secs > 0)) return undefined;
  return secs;
}

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

/**
 * Build the RealtimeModel constructor options for a `livekit:<plugin>/...` model.
 *
 * Exported for unit tests: this is where portable agent options are translated
 * into provider-native ones (Ultravox firstSpeakerSettings / inactivityMessages,
 * maxDuration / timeExceededMessage), so the mapping and its precedence rules
 * are testable without constructing plugin models or an AgentSession.
 */
export function buildRealtimeLlmOptions(
  modelName: string,
  agent: Agent,
  callId: string,
): Record<string, unknown> {
  const providerModelName = parseProviderModelName(modelName);
  const maxDurationString: string = agent?.options?.maxDuration || "305s";
  const llmOptions: Record<string, unknown> = {
    voice: agent?.options?.tts?.voice,
    maxDuration: maxDurationString,
    // Only the Ultravox plugin consumes timeExceededMessage — its native
    // wind-down line at maxDuration (empty ⇒ plugin default, matching the
    // native ultravox: driver). Other realtime providers ignore it and are
    // wound down by the worker hard-stop with a generic prompt instead
    // (voice-agent-runtime.ts; see api-doc.yaml `timeExceededMessage`).
    timeExceededMessage: agent?.options?.timeExceededMessage || undefined,
    instructions: agent?.prompt || "You are a helpful assistant.",
    callId,
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

  // Ultravox realtime: map portable `options.inactivity` → provider-native
  // `inactivityMessages` so Ultravox itself does the idle detection and speaks
  // the phrase in-model. Ultravox is speech-to-speech with no separate TTS, so
  // the JS-side say()/generateReply kick is unreliable for it; the generic SDK
  // user-away kick (voice-agent-runtime.ts) is gated to NON-ultravox models, and
  // the Ultravox session omits `userAwayTimeout`. A native
  // `vendorSpecific.ultravox.inactivityMessages` supplied by the caller wins.
  if (modelName.includes("livekit:ultravox/")) {
    const inactivitySecs = inactivityAwayTimeoutSecs(agent);
    const inactivityMsg =
      typeof agent?.options?.inactivity?.message === "string"
        ? agent.options.inactivity.message.trim()
        : "";
    const base =
      (llmOptions.vendorSpecific as Record<string, any> | undefined) ||
      vendorSpecific ||
      undefined;
    const alreadyNative = (base as any)?.ultravox?.inactivityMessages;
    if (inactivitySecs !== undefined && inactivityMsg && !alreadyNative) {
      // Ultravox fires each entry once, in sequence, after `duration` of further
      // user inactivity — so a short run of identical entries gives the
      // "re-fire every `timeout` of continued silence" behaviour (here up to
      // INACTIVITY_PROMPT_COUNT nudges).
      type InactivityEntry = {
        duration: string;
        message: string;
        endBehavior?: string;
      };
      const entry: InactivityEntry = {
        duration: `${inactivitySecs}s`,
        message: inactivityMsg,
      };
      const messages: InactivityEntry[] = Array.from(
        { length: INACTIVITY_PROMPT_COUNT },
        () => ({ ...entry }),
      );
      // endBehavior stays default (keep prompting, never hang up) unless the agent
      // opted in. HANG_UP_SOFT rather than STRICT so the model still delivers the
      // last prompt before ending, which is what the other end hears as
      // "hello? ... ok, goodbye" rather than a mid-word cut.
      if (inactivityHangupEnabled(agent)) {
        messages[messages.length - 1] = {
          ...entry,
          endBehavior: "END_BEHAVIOR_HANG_UP_SOFT",
        };
      }
      llmOptions.vendorSpecific = {
        ...(base || {}),
        ultravox: {
          ...((base && base.ultravox) || {}),
          inactivityMessages: messages,
        },
      };
    }
  }

  // Ultravox realtime: map portable `options.tts.language` (falling back to
  // `options.stt.language`) → provider-native `languageHint`, a BCP-47 tag that
  // guides Ultravox's own ASR and TTS. Ultravox is speech-to-speech, so there is
  // no separate TTS to carry the language the way the pipeline path does — this
  // is the only route the hint has. Omitted when unset or a "no fixed language"
  // sentinel, leaving Ultravox to auto-detect. A native
  // `vendorSpecific.ultravox.languageHint` wins (enforced in the plugin).
  if (modelName.includes("livekit:ultravox/")) {
    const language = agentLanguageTag(agent);
    if (language) {
      llmOptions.languageHint = language;
    }
  }

  return llmOptions;
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
  const { voiceMode, modelName, agent: agentDef, call, tools, vad } = params;

  // Resolve the agent's `promptMetadata` declaration ONCE, here: every session
  // passes through this factory — the initial run and each transfer_agent
  // handover — and both prompt sites (this one and buildRealtimeLlmOptions
  // below) read `agent.prompt`, so rewriting it here states the declared facts
  // (today's date, the caller's number, …) to whichever agent is now speaking,
  // freshly for each. A declaration that resolves to nothing returns the agent
  // untouched. See agent-lib/prompt-metadata.js.
  const basePrompt = agentDef?.prompt ?? "";
  const composedPrompt = promptWithMetadata(basePrompt, agentDef?.promptMetadata, call?.metadata);
  const agent =
    composedPrompt === basePrompt ? agentDef : ({ ...agentDef, prompt: composedPrompt } as Agent);

  const agentOptions = {
    instructions: agent?.prompt || "You are a helpful assistant.",
    tools,
  };

  const model =
    voiceMode === "pipeline"
      ? new PipelineVoiceAgent(agentOptions)
      : new voice.Agent(agentOptions);

  // Inactivity "kick": when options.inactivity is configured, set LiveKit's
  // user-away timeout so the session emits a `user_state_changed` → "away"
  // event after `timeout` of silence. The runtime (voice-agent-runtime.ts)
  // listens for that and speaks options.inactivity.message. Omitted entirely
  // when unset, so the default behaviour is unchanged.
  const userAwayTimeout = inactivityAwayTimeoutSecs(agent);
  const inactivityVoiceOptions =
    userAwayTimeout !== undefined ? { voiceOptions: { userAwayTimeout } } : {};

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
      ...inactivityVoiceOptions,
    } as any);
    return { session, model };
  }

  const { realtime } = getRealtimePlugin(modelName);
  if (!realtime) {
    throw new Error(
      `Unsupported realtime model: ${modelName} (expected livekit:<openai|ultravox|google>/...)`,
    );
  }

  const llmOptions = buildRealtimeLlmOptions(modelName, agent, call.id);

  // Ultravox does idle natively (mapped to provider inactivityMessages in
  // buildRealtimeLlmOptions); only NON-ultravox realtime uses the SDK
  // user-away timer + say()/generateReply kick.
  const realtimeInactivityVoiceOptions = modelName.includes("livekit:ultravox/")
    ? {}
    : inactivityVoiceOptions;

  const session = new voice.AgentSession({
    llm: new realtime.RealtimeModel(llmOptions),
    // Drop early user audio while agent speech is uninterruptible (greeting mode).
    turnHandling: {
      interruption: {
        discardAudioIfUninterruptible: true,
      },
    },
    ...realtimeInactivityVoiceOptions,
  } as any);
  return { session, model };
}
