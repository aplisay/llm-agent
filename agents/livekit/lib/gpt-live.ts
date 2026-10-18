/**
 * GPT-Live: a voice agent whose backend is a text agent. docs/gpt-live.md describes it for users;
 * agents/pipecat/pipecat_aplisay/gpt_live.py is the Pipecat twin. The texts sent to the model
 * must stay byte-identical with it.
 */
import { llm } from "@livekit/agents";
import { getByPath } from "../agent-lib/metadata-path.js";
import type { Agent, AgentFunction, CallMetadata, CustomVoice } from "./api-client.js";
import { agentLanguageTag } from "./pipeline-inference-options.js";

/** Must match OPENAI_LIVE_DEFAULT_VOICE in lib/voices/openai-live.js. */
export const GPT_LIVE_DEFAULT_VOICE = "marin";
/** OpenAI's custom voice ids start with this; the named voices never do (docs/custom-voices.md). */
export const CUSTOM_VOICE_ID_PREFIX = "voice_";
export const SYNTHETIC_BACKEND_MODEL_NAME = "text:openai/gpt-5.6-luna";
export const DELEGATE_PLATFORM = "delegate";
export const OPENING_INSTRUCTION = "Greet the caller and ask how you can help.";

export const VOICE_DELEGATION_POLICY = `## Delegation
You have no tools of your own. A backend assistant handles every lookup,
booking, record change, transfer, hangup and any question that needs a tool
or careful reasoning. Delegate as soon as the caller asks for one of those;
include what the caller wants and every detail they gave. While the backend
works, keep the conversation going and tell the caller you are checking.
Relay the backend's answer in your own words when it arrives, and ignore a
result the conversation has already moved past. Answer simple conversational
questions yourself.`;

export const BACKEND_TOOL_POLICY = `## Working for a live voice call
You are the backend of a live phone conversation. The voice assistant talking
to the caller sends you the conversation; the caller cannot hear you. The
transcript may contain recognition errors, so use the most likely intent.
Use your tools to answer and to act; never claim an action completed without
a tool result confirming it. Reply in concise plain text for the voice
assistant to speak: no Markdown, no lists, no raw JSON.`;

export const DELEGATION_FAILED_COMMENTARY =
  "Apologise briefly: you could not complete that request just now.";
export const NO_ANSWER_COMMENTARY =
  "The request finished without an answer; tell the caller you could not get an answer.";
export const DELEGATION_STRANDED_COMMENTARY =
  "Tell the caller you could not look that up just now, apologise briefly, and offer to help " +
  "with what you already know or to take a message. Do not say you will check again.";

/** The service caps an append at 500 tokens; chunks use a lower budget because the count is an estimate. */
export const MAX_CONTEXT_APPEND_TOKENS = 450;
export const ERROR_INPUT_BUFFER_FULL = "response_input_buffer_full";
export const ERROR_OUTPUTS_REQUIRED = "function_call_outputs_required";
/** Close reasons that end the call rather than a reconnect. Pipecat's PROVIDER_ENDED_REASONS. */
export const PROVIDER_ENDED_REASONS: ReadonlySet<string> = new Set([
  "expired",
  "content",
  "connection_lost",
]);

export type DelegationMode = "responses" | "client";

/** `openai/gpt-live*`, the part of a model name after the handler. */
export function isGptLiveModelId(modelId: string | undefined): boolean {
  return /^openai\/gpt-live/i.test((modelId ?? "").trim());
}

/** `livekit:openai/gpt-live-1` and any later GPT-Live row. */
export function isGptLiveModelName(modelName: string | undefined): boolean {
  const m = /^livekit:(.+)$/i.exec((modelName ?? "").trim());
  return m ? isGptLiveModelId(m[1]) : false;
}

function functionList(agent: Agent): AgentFunction[] {
  const fns = (agent?.functions ?? []) as unknown;
  const list = Array.isArray(fns) ? fns : Object.values((fns ?? {}) as Record<string, unknown>);
  return list.filter((f): f is AgentFunction => typeof f === "object" && f !== null);
}

export function isDelegateFunction(fn: AgentFunction): boolean {
  return fn.implementation === "builtin" && fn.platform === DELEGATE_PLATFORM;
}

export function findDelegateFunction(agent: Agent): AgentFunction | undefined {
  return functionList(agent).find(isDelegateFunction);
}

/** A `static` id, or a `metadata` dot path resolved against the call metadata. */
export function resolveDelegateTarget(
  fn: AgentFunction,
  metadata: CallMetadata | Record<string, unknown> | undefined,
): string | undefined {
  const param = (fn.input_schema?.properties?.agent ?? {}) as { source?: string; from?: unknown };
  let value: unknown;
  if (param.source === "static") value = param.from;
  else if (param.source === "metadata") value = getByPath(metadata ?? {}, String(param.from ?? ""));
  else return undefined;
  const text = value === undefined || value === null ? "" : String(value).trim();
  return text || undefined;
}

/** `text:openai/gpt-5.6-terra` -> `openai/gpt-5.6-terra`. */
export function bareModelId(modelName: string): string {
  const name = (modelName ?? "").trim();
  const colon = name.indexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/** Responses delegation for an OpenAI text model, client delegation for any other. */
export function delegationMode(modelName: string): DelegationMode {
  return bareModelId(modelName).toLowerCase().startsWith("openai/") ? "responses" : "client";
}

/** The backend made from the voice agent itself. Its own tools reach the backend through the merge. */
export function syntheticBackend(agent: Agent, modelName = SYNTHETIC_BACKEND_MODEL_NAME): Agent {
  return {
    id: `synthetic:${agent?.id || "agent"}`,
    name: agent?.name,
    type: "text",
    modelName,
    prompt: agent?.prompt ?? "",
    promptMetadata: agent?.promptMetadata,
    functions: [],
    keys: [],
    options: { ...(agent?.options ?? {}) },
    organisationId: agent?.organisationId,
    userId: agent?.userId,
  } as Agent;
}

export interface DelegateSpec {
  agent: Agent;
  synthetic: boolean;
  mode: DelegationMode;
}

/** The backend model as the Responses API names it, and as usage rows name it. */
export function delegateBackend(spec: DelegateSpec): { modelId: string; vendor?: string; model: string } {
  const modelId = bareModelId(spec.agent.modelName || SYNTHETIC_BACKEND_MODEL_NAME);
  const slash = modelId.indexOf("/");
  return slash >= 0
    ? { modelId, vendor: modelId.slice(0, slash), model: modelId.slice(slash + 1) }
    : { modelId, model: modelId };
}

interface WarnLogger {
  warn(obj: object, msg: string): void;
}

/**
 * The session's backend. A missing, foreign, wrongly typed or unloadable delegate falls back to
 * the synthetic backend with a warning, never failing the call.
 */
export async function resolveDelegate(
  agent: Agent,
  metadata: CallMetadata | Record<string, unknown> | undefined,
  organisationId: string | undefined,
  {
    fetchAgent,
    log,
  }: { fetchAgent: (id: string, organisationId?: string) => Promise<Agent>; log: WarnLogger },
): Promise<DelegateSpec> {
  const synthetic = (): DelegateSpec => ({
    agent: syntheticBackend(agent),
    synthetic: true,
    mode: "responses",
  });
  const fn = findDelegateFunction(agent);
  if (!fn) return synthetic();
  const target = resolveDelegateTarget(fn, metadata);
  if (!target) {
    log.warn(
      { function: fn.name },
      "delegate function names no agent (missing or unresolved metadata target); using the synthetic backend",
    );
    return synthetic();
  }
  let delegate: Agent;
  try {
    delegate = await fetchAgent(target, organisationId);
  } catch (e) {
    log.warn(
      { function: fn.name, target, error: (e as Error)?.message },
      "could not load the delegate agent; using the synthetic backend",
    );
    return synthetic();
  }
  if (!delegate || typeof delegate !== "object" || (delegate.type ?? "interactive-audio") !== "text") {
    log.warn({ function: fn.name, target }, "delegate agent is not a text agent; using the synthetic backend");
    return synthetic();
  }
  return { agent: delegate, synthetic: false, mode: delegationMode(delegate.modelName ?? "") };
}

/** GPT-Live has no session language field, so the language rides on the voice instructions. */
export function languageLine(agent: Agent): string | undefined {
  const tag = agentLanguageTag(agent);
  return tag ? `Speak ${tag} unless the caller asks you to switch language.` : undefined;
}

export function composeVoiceInstructions(
  voicePrompt: string,
  { language, voiceLine }: { language?: string; voiceLine?: string } = {},
): string {
  const parts = [(voicePrompt ?? "").trim() || "You are a helpful voice assistant."];
  if (language) parts.push(language);
  if (voiceLine) parts.push(voiceLine);
  parts.push(VOICE_DELEGATION_POLICY);
  return parts.join("\n\n");
}

/**
 * The agent's OpenAI custom voice, as the API server resolved it into `customVoice`, when it is the
 * voice the agent names. The server resolves only a ready voice of the agent's own organisation.
 */
export function customVoice(agent: Agent): CustomVoice | undefined {
  const cv = agent?.customVoice;
  if (!cv || cv.vendor !== "openai" || !cv.voice) return undefined;
  return cv.voice === agent?.options?.tts?.voice ? cv : undefined;
}

/** OpenAI asks for a prompt voice's description in the session instructions too. */
export function customVoiceLine(cv: CustomVoice | undefined): string | undefined {
  const prompt = String(cv?.prompt ?? "").trim();
  return cv?.method === "prompt" && prompt ? `Your speaking voice: ${prompt}` : undefined;
}

/**
 * The voice for `session.start`: a custom voice as `{ id }`, else the named voice. A `voice_` id the
 * server did not resolve (deleted, or another organisation's) would make OpenAI refuse the session,
 * so it falls back to the default voice and is returned as `unresolved` for the caller to log.
 */
export function gptLiveVoice(agent: Agent): {
  voice: string | { id: string };
  customVoice?: CustomVoice;
  unresolved?: string;
} {
  const cv = customVoice(agent);
  if (cv?.voice) return { voice: { id: cv.voice }, customVoice: cv };
  const named = String(agent?.options?.tts?.voice ?? "").trim();
  if (named.startsWith(CUSTOM_VOICE_ID_PREFIX)) return { voice: GPT_LIVE_DEFAULT_VOICE, unresolved: named };
  return { voice: named || GPT_LIVE_DEFAULT_VOICE };
}

export function composeBackendInstructions(backendPrompt: string, { toolNames }: { toolNames: string[] }): string {
  const parts = [(backendPrompt ?? "").trim() || "You are a helpful assistant.", BACKEND_TOOL_POLICY];
  if (toolNames.length) parts.push(`Tools available to you: ${[...toolNames].sort().join(", ")}.`);
  return parts.join("\n\n");
}

/** The backend tool set: the delegate's tools, then the voice agent's under names the delegate did not take. */
export function mergeTools(
  voiceTools: llm.ToolContext,
  delegateTools: llm.ToolContext | undefined,
  log: WarnLogger,
): llm.ToolContext {
  if (!delegateTools) return voiceTools;
  const taken = new Set(Object.keys(delegateTools.functionTools));
  const clashes: string[] = [];
  const voiceOnly = voiceTools.flatten().filter((tool) => {
    if (!taken.has(tool.id)) return true;
    clashes.push(tool.id);
    return false;
  });
  if (clashes.length) {
    log.warn(
      { tools: clashes },
      `delegate and voice agent both declare these tools; the delegate's definitions win: ${clashes.join(", ")}`,
    );
  }
  return new llm.ToolContext([...delegateTools.flatten(), ...voiceOnly] as llm.ToolContextEntry[]);
}

/** `options.effort` and `options.maxTokens`; temperature is not accepted for a delegated model. */
export function backendSettings(delegate: Agent): { effort?: string; maxTokens?: number } {
  const options = (delegate?.options ?? {}) as { effort?: unknown; maxTokens?: unknown };
  const out: { effort?: string; maxTokens?: number } = {};
  if (typeof options.effort === "string" && options.effort.trim()) {
    out.effort = options.effort.trim().toLowerCase();
  }
  if (typeof options.maxTokens === "number" && Number.isInteger(options.maxTokens) && options.maxTokens > 0) {
    out.maxTokens = options.maxTokens;
  }
  return out;
}

/** `options.vendorSpecific.openai.live`, merged into `session.start`. */
export function liveOverrides(agent: Agent): Record<string, unknown> {
  const live = (agent?.options?.vendorSpecific as Record<string, any> | undefined)?.openai?.live;
  return live && typeof live === "object" && !Array.isArray(live) ? { ...live } : {};
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Recursive merge; `override` wins on a shared leaf. */
export function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

function greetingParts(agent: Agent): { text: string; instructions: string } {
  const greeting = (agent?.options?.greeting ?? {}) as { text?: unknown; instructions?: unknown };
  return {
    text: typeof greeting.text === "string" ? greeting.text.trim() : "",
    instructions: typeof greeting.instructions === "string" ? greeting.instructions.trim() : "",
  };
}

export function hasGreeting(agent: Agent): boolean {
  const { text, instructions } = greetingParts(agent);
  return Boolean(text || instructions);
}

/** The first turn: the greeting text, the greeting instructions, or the platform default. */
export function greetingOpeningInstruction(agent: Agent): string {
  const { text, instructions } = greetingParts(agent);
  // The P0 spike measured this wording as spoken verbatim in four of four runs.
  if (text) return `Immediately say the following exactly and in full, then listen: ${text}`;
  if (instructions) {
    return (
      "Immediately open the conversation. For your opening line only, follow these " +
      `instructions, then listen: ${instructions}`
    );
  }
  return OPENING_INSTRUCTION;
}

export function inactivityCommentary(message: string): string {
  return `The caller has gone quiet. Say this to them now, then wait: ${message}`;
}

/** Quarter-tokens: one per ASCII character, four for any other. Pipecat's `_estimated_tokens`. */
function tokenQuarters(text: string): number {
  let quarters = 0;
  for (const char of text) quarters += char.charCodeAt(0) < 128 ? 1 : 4;
  return quarters;
}

export function estimatedTokens(text: string): number {
  return Math.floor((tokenQuarters(text) + 3) / 4);
}

function splitAtTokenLimit(text: string, tokenLimit: number): [string, string] {
  const budget = tokenLimit * 4;
  const chars = [...text];
  let end = chars.length;
  let cost = 0;
  for (let i = 0; i < chars.length; i++) {
    cost += tokenQuarters(chars[i]!);
    if (cost > budget) {
      end = Math.max(i, 1);
      break;
    }
  }
  let prefix = chars.slice(0, end).join("");
  const space = prefix.lastIndexOf(" ");
  if (space > 0) prefix = prefix.slice(0, space);
  return [prefix.trim(), text.slice(prefix.length).trim()];
}

/** Chunks of at most `tokenLimit` estimated tokens, broken on sentences, then spaces. */
export function chunkText(text: string, tokenLimit = MAX_CONTEXT_APPEND_TOKENS): string[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];
  if (estimatedTokens(trimmed) <= tokenLimit) return [trimmed];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (let piece of trimmed.split(/(?<=[.!?])\s+|\n+/)) {
    piece = piece.trim();
    while (estimatedTokens(piece) > tokenLimit) {
      const [head, rest] = splitAtTokenLimit(piece, tokenLimit);
      flush();
      chunks.push(head);
      piece = rest;
    }
    if (!piece) continue;
    if (current && estimatedTokens(`${current} ${piece}`) > tokenLimit) flush();
    current = `${current} ${piece}`.trim();
  }
  flush();
  return chunks;
}

export interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

/** Upstream Pipecat's `_render_transcript_request`: the task a client delegation hands the backend. */
export function renderTranscriptRequest(conversation: TranscriptLine[], first: boolean): string {
  const lines: string[] = [];
  const spoken = conversation.filter(({ text }) => text.trim());
  if (spoken.length) {
    lines.push(first ? "Voice conversation so far:" : "Voice conversation since the previous delegation:");
    for (const { role, text } of spoken) lines.push(`${role.toUpperCase()}: ${text.trim()}`);
    lines.push("");
  }
  lines.push("Act on the user's most recent request in the conversation above.");
  return lines.join("\n");
}

/** The text a subagent result gives the voice model to speak. */
export function subagentAnswerText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && !Array.isArray(result)) {
    for (const key of ["text", "answer", "result", "summary"]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return JSON.stringify(result);
}

/** Call ids named in a `function_call_outputs_required` message, in order, without duplicates. */
export function missingCallIds(message: string | undefined): string[] {
  const ids: string[] = [];
  for (const [id] of (message ?? "").matchAll(/\bcall_[A-Za-z0-9]+/g)) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The stand-in output for a tool result the backend refused. */
export function droppedOutputStub(callId: string): string {
  return JSON.stringify({
    error: "result_too_large",
    message:
      "This result was too large for the conversation and was not delivered. " +
      "Ask again for a smaller part of it (a single section or a narrower " +
      "query), or answer from what you already have. Do not retry the same " +
      "request unchanged.",
    call_id: callId,
  });
}

/** What the runtime resolves before it builds a GPT-Live session. */
export interface GptLivePrepared {
  spec: DelegateSpec;
  /** The merged backend tools; empty in client mode, where the backend runs its own. */
  tools: llm.ToolContext;
}

/**
 * Resolve the delegate and build the backend tools, each agent's tools with its own keys.
 * `buildTools` is the runtime's createTools for one agent definition.
 */
export async function prepareGptLive({
  agent,
  metadata,
  organisationId,
  buildTools,
  fetchAgent,
  log,
}: {
  agent: Agent;
  metadata: CallMetadata | Record<string, unknown> | undefined;
  organisationId: string | undefined;
  buildTools: (agent: Agent) => llm.ToolContext;
  fetchAgent: (id: string, organisationId?: string) => Promise<Agent>;
  log: WarnLogger;
}): Promise<GptLivePrepared> {
  const spec = await resolveDelegate(agent, metadata, organisationId, { fetchAgent, log });
  if (spec.mode === "client") {
    // The plugin refuses tools in client mode: nothing on the OpenAI side could call them.
    return { spec, tools: llm.ToolContext.empty() };
  }
  const voiceTools = buildTools(agent);
  const delegateTools = spec.synthetic ? undefined : buildTools(spec.agent);
  return { spec, tools: mergeTools(voiceTools, delegateTools, log) };
}
