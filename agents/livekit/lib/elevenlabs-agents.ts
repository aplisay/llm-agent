/**
 * ElevenLabs Agents on the LiveKit worker: the SDK-free helpers.
 *
 * docs/elevenlabs-agents.md is the user-facing description, and
 * agents/pipecat/pipecat_aplisay/elevenlabs_agents.py the Pipecat twin: the
 * constants, the hosted-agent configuration and the per-conversation
 * overrides are kept identical so both workers converge on the same hosted
 * agents. The conversation itself is lib/elevenlabs-realtime.ts.
 */
import type { Agent } from "./api-client.js";
import { createHash } from "node:crypto";
import { greetingOpeningInstruction } from "./gpt-live.js";
import { agentLanguageTag } from "./pipeline-inference-options.js";
import { ttsSpeedFor } from "./tts-speed.js";

/** The provider segment of the rows (`livekit:elevenlabs/<llm>`). */
export const ELEVENLABS_PROVIDER = "elevenlabs";

/** Must match ELEVENLABS_DEFAULT_VOICE in lib/elevenlabs-agents.js. */
export const ELEVENLABS_DEFAULT_VOICE = "cjVigY5qzO86Huf0OWal";

export const INPUT_AUDIO_FORMAT = "pcm_16000";
export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_AUDIO_FORMAT = "pcm_24000";
export const OUTPUT_SAMPLE_RATE = 24000;

/** ElevenLabs's own range for `max_duration_seconds` (checked 2026-10-22). */
export const MIN_DURATION_SECONDS = 60;
export const MAX_DURATION_SECONDS = 7200;

/** Pushed out so the platform's `options.inactivity` kick speaks first. */
export const TURN_TIMEOUT_SECONDS = 300;

/** The API maximum; the platform's own tool timeouts apply underneath. */
export const TOOL_RESPONSE_TIMEOUT_SECONDS = 120;

export const CLIENT_EVENTS = [
  "conversation_initiation_metadata",
  "audio",
  "interruption",
  "user_transcript",
  "agent_response",
  "agent_response_correction",
  "agent_response_complete",
  "client_tool_call",
  "agent_tool_response",
  "ping",
  "client_error",
];

/** Bump with the Python twin when the mapping changes shape. */
export const CONFIG_VERSION = 1;

export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "end_call",
  "language_detection",
  "skip_turn",
  "transfer_to_agent",
  "transfer_to_number",
  "voicemail_detection",
  "play_keypad_touch_tone",
]);

export const PROTECTED_CONFIG_PATHS: ReadonlySet<string> = new Set([
  "agent.prompt.prompt",
  "agent.prompt.llm",
  "agent.prompt.tools",
  "agent.prompt.tool_ids",
  "agent.prompt.tool_ids_strict",
  "agent.prompt.built_in_tools",
  "agent.prompt.mcp_server_ids",
  "agent.prompt.native_mcp_server_ids",
  "agent.prompt.knowledge_base",
  "agent.prompt.custom_llm",
  "agent.first_message",
  "tts.voice_id",
  "tts.agent_output_audio_format",
  "asr.user_input_audio_format",
  "conversation.client_events",
  "conversation.text_only",
  "conversation.max_duration_seconds",
]);

export const DEFAULT_API_BASE = "https://api.elevenlabs.io";

/** True for every `livekit:elevenlabs/` row. */
export function isElevenLabsModelName(modelName: string | undefined): boolean {
  return /^livekit:elevenlabs\//i.test(modelName || "");
}

/** `livekit:elevenlabs/gemini-2.5-flash` or `elevenlabs/gemini-2.5-flash` -> `gemini-2.5-flash`. */
export function elevenLabsLlm(modelName: string): string {
  const rest = (modelName || "").replace(/^livekit:/, "");
  const i = rest.indexOf("/");
  return i === -1 ? "" : rest.slice(i + 1).trim();
}

export function apiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ELEVENLABS_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

export function agentNamePrefix(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ELEVENLABS_AGENT_PREFIX || "aplisay").trim() || "aplisay";
}

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Recursive merge, `override` winning on a shared leaf. */
export function deepMerge(base: Dict, override: Dict): Dict {
  const out: Dict = { ...(base || {}) };
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = isDict(value) && isDict(out[key]) ? deepMerge(out[key] as Dict, value) : value;
  }
  return out;
}

/** `config` without the platform-owned paths. */
export function stripProtectedPaths(config: Dict, prefix = ""): Dict {
  const out: Dict = {};
  for (const [key, value] of Object.entries(config || {})) {
    const path = `${prefix}${key}`;
    if (PROTECTED_CONFIG_PATHS.has(path)) continue;
    out[key] = isDict(value) ? stripProtectedPaths(value, `${path}.`) : value;
  }
  return out;
}

/** `options.vendorSpecific.elevenlabs.conversation_config`, minus the platform's paths. */
export function vendorConfig(agent: Agent | undefined): Dict {
  const block = (agent?.options?.vendorSpecific as Dict | undefined)?.elevenlabs;
  const config = isDict(block) ? (block as Dict).conversation_config : undefined;
  return isDict(config) ? stripProtectedPaths(config) : {};
}

// ---- tools ---------------------------------------------------------------------

const SCHEMA_KEYS = ["type", "description", "enum", "items", "properties", "required"] as const;

function cleanProperty(prop: unknown): Dict {
  if (!isDict(prop)) return { type: "string", description: "" };
  const out: Dict = {};
  for (const key of SCHEMA_KEYS) {
    if (!(key in prop)) continue;
    const value = prop[key];
    if (key === "items") out.items = cleanProperty(value);
    else if (key === "properties") {
      out.properties = isDict(value)
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanProperty(v)]))
        : {};
    } else if (key === "required") {
      if (Array.isArray(value)) out.required = value.filter((v) => typeof v === "string");
    } else if (key === "enum") {
      if (Array.isArray(value) && value.length) out.enum = [...value];
    } else out[key] = value;
  }
  if (out.type === undefined) out.type = "properties" in out ? "object" : "items" in out ? "array" : "string";
  if (out.description === undefined) out.description = "";
  return out;
}

/** A tool as the SDK's ToolContext holds it: a description and a JSON-schema parameters object. */
export interface ToolSchema {
  name: string;
  description?: string;
  parameters?: { properties?: Dict; required?: unknown } | undefined;
}

/** One platform tool as an ElevenLabs client tool, or undefined for a reserved name. */
export function clientTool(schema: ToolSchema): Dict | undefined {
  if (RESERVED_TOOL_NAMES.has(schema.name)) return undefined;
  const tool: Dict = {
    type: "client",
    name: schema.name,
    description: schema.description || "",
    expects_response: true,
    response_timeout_secs: TOOL_RESPONSE_TIMEOUT_SECONDS,
  };
  const properties = schema.parameters?.properties;
  if (isDict(properties) && Object.keys(properties).length) {
    const required = Array.isArray(schema.parameters?.required) ? schema.parameters!.required : [];
    tool.parameters = {
      type: "object",
      description: "",
      properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, cleanProperty(v)])),
      required: required.filter((r: unknown) => typeof r === "string" && r in properties),
    };
  }
  return tool;
}

export function clientTools(schemas: ToolSchema[]): Dict[] {
  return schemas.map(clientTool).filter((t): t is Dict => t !== undefined);
}

// ---- the hosted agent -----------------------------------------------------------

const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The create-agent body, before the name; the Python twin's `agent_config`. */
export function agentConfig(agent: Agent, { llm, toolSchemas }: { llm: string; toolSchemas: ToolSchema[] }): Dict {
  const options = (agent?.options || {}) as Dict;
  const prompt: Dict = {
    prompt: "Configured per conversation.",
    llm,
    tools: clientTools(toolSchemas),
    ignore_default_personality: true,
  };
  const temperature = asNumber(options.temperature);
  if (temperature !== undefined) prompt.temperature = temperature;
  const maxTokens = options.maxTokens;
  if (typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens > 0) prompt.max_tokens = maxTokens;
  const conversationConfig = deepMerge(
    {
      agent: { prompt, first_message: "", language: "en" },
      tts: { voice_id: ELEVENLABS_DEFAULT_VOICE, agent_output_audio_format: OUTPUT_AUDIO_FORMAT },
      asr: { user_input_audio_format: INPUT_AUDIO_FORMAT },
      turn: { turn_timeout: TURN_TIMEOUT_SECONDS },
      conversation: { max_duration_seconds: MAX_DURATION_SECONDS, client_events: [...CLIENT_EVENTS] },
    },
    vendorConfig(agent),
  );
  return {
    _v: CONFIG_VERSION,
    conversation_config: conversationConfig,
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { first_message: true, language: true, prompt: { prompt: true } },
          tts: { voice_id: true, speed: true, stability: true, similarity_boost: true },
          conversation: { max_duration_seconds: true },
        },
      },
      privacy: { record_voice: false, retention_days: 1 },
      auth: { enable_auth: true },
    },
  };
}

/** JSON with sorted keys and no whitespace, the Python twin's canonical form. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isDict(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function configHash(config: Dict): string {
  return createHash("sha256").update(canonicalJson(config), "utf8").digest("hex").slice(0, 20);
}

export function agentName(digest: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${agentNamePrefix(env)}:${digest}`;
}

export function createBody(config: Dict, name: string, env: NodeJS.ProcessEnv = process.env): Dict {
  const body: Dict = Object.fromEntries(Object.entries(config).filter(([k]) => !k.startsWith("_")));
  body.name = name;
  body.tags = ["aplisay", agentNamePrefix(env)];
  return body;
}

// ---- per conversation -----------------------------------------------------------

/** `options.maxDuration` in seconds (a number, or `"1800s"`), or undefined. */
export function maxDurationSeconds(agent: Agent | undefined): number | undefined {
  const value = (agent?.options as Dict | undefined)?.maxDuration;
  if (typeof value === "number") return value > 0 ? Math.floor(value) : undefined;
  if (typeof value === "string") {
    const n = Number.parseFloat(value.trim().replace(/s$/i, ""));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  }
  return undefined;
}

/** A minute more than the worker's own cap, within ElevenLabs's range. */
export function clampDuration(seconds: number | undefined): number {
  if (seconds === undefined || seconds <= 0) return MAX_DURATION_SECONDS;
  return Math.min(MAX_DURATION_SECONDS, Math.max(MIN_DURATION_SECONDS, Math.floor(seconds + 60)));
}

/** The primary subtag of the agent's language (`en-GB` -> `en`), or undefined. */
export function languageCode(agent: Agent | undefined): string | undefined {
  const tag = agentLanguageTag(agent as Agent);
  const primary = tag?.split("-")[0]?.trim().toLowerCase();
  return primary || undefined;
}

export function conversationOverrides(
  agent: Agent,
  { systemPrompt, firstMessage, maxDurationSecs }: { systemPrompt: string; firstMessage: string; maxDurationSecs?: number },
): Dict {
  const agentBlock: Dict = { prompt: { prompt: systemPrompt || "" }, first_message: firstMessage || "" };
  const language = languageCode(agent);
  if (language) agentBlock.language = language;
  const tts: Dict = { voice_id: (agent?.options?.tts?.voice as string | undefined) || ELEVENLABS_DEFAULT_VOICE };
  const speed = ttsSpeedFor(agent, ELEVENLABS_PROVIDER);
  if (speed !== undefined) tts.speed = speed;
  return { agent: agentBlock, tts, conversation: { max_duration_seconds: clampDuration(maxDurationSecs) } };
}

export function initiationMessage(overrides: Dict): Dict {
  return {
    type: "conversation_initiation_client_data",
    conversation_config_override: overrides,
    source_info: { source: "js_sdk", version: "aplisay-livekit" },
  };
}

// ---- what the worker says to the agent --------------------------------------------

export function greetingText(agent: Agent | undefined): string {
  return (agent?.options?.greeting?.text || "").trim();
}

export function greetingInstructions(agent: Agent | undefined): string {
  return (agent?.options?.greeting?.instructions || "").trim();
}

/** A platform instruction as the user-side message the agent acts on. */
export function instructionMessage(instruction: string): string {
  return `(Instruction from the system, not the caller: ${instruction.trim()})`;
}

/**
 * How the agent speaks first: a verbatim `firstMessage` (a new call with
 * `greeting.text`), or an `openingMessage` the worker sends once the
 * conversation is ready (instructions, no greeting, a handover or takeover).
 */
export function openingPlan(agent: Agent, platformOpening?: string): { firstMessage: string; openingMessage?: string } {
  if (platformOpening) return { firstMessage: "", openingMessage: instructionMessage(platformOpening) };
  const text = greetingText(agent);
  if (text) return { firstMessage: text };
  return { firstMessage: "", openingMessage: instructionMessage(greetingOpeningInstruction(agent)) };
}

/** Keypad digits, as the DTMF aggregator flushes them. */
export function isDtmfText(text: string): boolean {
  return /^[0-9*#]{1,32}$/.test(text.trim());
}

const AUDIO_TAG = /\[[a-z][a-z ,'-]{0,40}\]\s*/g;

/** ElevenLabs's expressive models emit tags such as `[warm]`: direction, not speech. */
export function stripAudioTags(text: string): string {
  return (text || "").replace(AUDIO_TAG, "").trim();
}
