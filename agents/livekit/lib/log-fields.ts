import type { voice } from "@livekit/agents";

/**
 * Log fields for objects that are not logged whole: SDK models and plugins carry their provider
 * options, and agent and instance records their tool keys and recording key. Worker log lines
 * also go into the call's invocation log (see logger.ts).
 */

type Row = Record<string, unknown>;

const isRow = (x: unknown): x is Row => typeof x === "object" && x !== null;

/** `label()` on LLMs and realtime models, `label` on STT and TTS; else the class name. */
export function labelOf(x: unknown): string | undefined {
  if (typeof x === "string") return x;
  if (!isRow(x)) return undefined;
  try {
    const { label } = x as { label?: unknown };
    const value = typeof label === "function" ? label.call(x) : label;
    if (typeof value === "string" && value) return value;
  } catch {
    // Fall through to the class name.
  }
  return (x as object).constructor?.name;
}

/** An error's name, message and scalar fields. Nested objects (response bodies, sockets) stay out. */
function errorForLog(e: unknown): unknown {
  if (!isRow(e)) return e;
  const out: Row = e instanceof Error ? { name: e.name, message: e.message } : {};
  for (const [k, v] of Object.entries(e)) {
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) out[k] = v;
  }
  return out;
}

/** The SDK's `{ type, label, recoverable, error }` from an error or close event, or a bare Error. */
function innerErrorForLog(inner: unknown): unknown {
  if (!isRow(inner) || inner instanceof Error) return errorForLog(inner);
  const { type, label, recoverable, error } = inner;
  return { type, label, recoverable, error: errorForLog(error) };
}

/** An AgentSession error or close event, with the `source` model or plugin as its label. */
export function sessionEventForLog(ev: voice.ErrorEvent | voice.CloseEvent): Row {
  return {
    type: ev.type,
    ...("reason" in ev && { reason: ev.reason }),
    ...("source" in ev && { source: labelOf(ev.source) }),
    error: innerErrorForLog(ev.error),
    createdAt: ev.createdAt,
  };
}

/** The session's models by label, in place of the AgentSession. */
export function sessionModelsForLog(
  session: Pick<voice.AgentSession, "llm" | "stt" | "tts">,
): Row {
  return { llm: labelOf(session.llm), stt: labelOf(session.stt), tts: labelOf(session.tts) };
}

/** `x` without `x[field][key]`. */
function withoutNested(x: unknown, field: string, key: string): unknown {
  if (!isRow(x) || !isRow(x[field])) return x;
  const { [key]: _omit, ...inner } = x[field];
  return { ...x, [field]: inner };
}

/** Field names in place of values, two levels deep: `{ crm: ["id", "region"] }`. */
function fieldNames(x: unknown): unknown {
  if (!isRow(x)) return undefined;
  return Object.fromEntries(
    Object.entries(x).map(([k, v]) => [k, isRow(v) ? Object.keys(v) : typeof v]),
  );
}

/**
 * An agent definition with its tool `keys` by name, and no `options.recording.key` or
 * `options.callHook.hashKey`.
 */
export function agentForLog(agent: unknown): unknown {
  if (!isRow(agent)) return agent;
  const { keys, options, ...rest } = agent;
  return {
    ...rest,
    ...(options !== undefined && {
      options: withoutNested(withoutNested(options, "recording", "key"), "callHook", "hashKey"),
    }),
    ...(Array.isArray(keys) && { keys: keys.map((k) => (isRow(k) ? k.name : undefined)) }),
  };
}

/**
 * An instance without its `key` or `recording.key`, with `metadata` by field name, and its agent
 * by `agentId` only: log the agent itself once, through agentForLog.
 */
export function instanceForLog(instance: unknown): unknown {
  if (!isRow(instance)) return instance;
  const { key: _key, Agent: agent, metadata, ...rest } = withoutNested(instance, "recording", "key") as Row;
  return {
    ...rest,
    ...(rest.agentId === undefined && isRow(agent) && { agentId: agent.id }),
    ...(metadata != null && { metadata: fieldNames(metadata) }),
  };
}

/** A call scenario with its agent and instance by id, and `callMetadata` by field name. */
export function scenarioForLog(scenario: unknown): unknown {
  if (!isRow(scenario)) return scenario;
  const { agent, instance, callMetadata, ...rest } = scenario;
  return {
    ...rest,
    agentId: isRow(agent) ? agent.id : undefined,
    instanceId: isRow(instance) ? instance.id : undefined,
    callMetadata: isRow(callMetadata) ? Object.keys(callMetadata) : undefined,
  };
}
