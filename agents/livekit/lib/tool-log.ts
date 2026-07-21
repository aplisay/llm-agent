/**
 * Structured, INFO-level logging of every LLM tool / MCP call and its result
 * into the per-call InvocationLog ("debug log").
 *
 * The `event` field is the stable marker that distinguishes these entries from
 * all other InvocationLog output:
 *   - `event: "tool_call"`   — a tool/MCP call is being invoked (INFO)
 *   - `event: "tool_result"` — the call returned (INFO on success, WARN on
 *                              error — both are captured at the prod `info`
 *                              level, so failures stay visible while keeping
 *                              their severity)
 *
 * The field shape is kept deliberately identical to the Pipecat worker's
 * `pipecat_aplisay/tool_log.py` so tool activity reads and correlates the same
 * across the `livekit-agent` and `pipecat-agent` subsystems:
 *   tool (name), kind (function|builtin|mcp|subagent), arguments, ok, result,
 *   error, durationMs.
 *
 * Only log through the CAPTURING logger (`agents/livekit/lib/logger.js`). Logs
 * emitted inside the shared `agent-lib/function-handler.js` use a different,
 * non-capturing pino instance and never reach the InvocationLog buffer, so the
 * instrumentation lives at the tool-dispatch choke point in agent-tools.ts.
 */

/**
 * Coarse classification of a tool, shared with the pipecat worker.
 * `subagent` is a `platform: "subagent"` builtin — a call that delegates to a
 * headless `text` agent and returns its result inline; it is split out from the
 * generic `builtin` so consumers can surface agent-to-agent delegation as its
 * own category (the polite.ai calls drawer renders it as an AGENT row).
 */
export type ToolKind = "function" | "builtin" | "mcp" | "subagent";

/** Minimal structural logger type so this stays decoupled from pino's exports. */
interface ToolLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

// Cap any single logged value so one large tool result (e.g. a big REST
// payload) cannot dominate the size-bounded InvocationLog and crowd out the
// rest of the call's log. Matches the pipecat helper's cap.
const MAX_LOG_VALUE_CHARS = 8000;

/**
 * Return `value` unchanged when it serialises small (so pino logs it
 * structured), otherwise a truncated string with an explicit marker.
 */
export function truncateForLog(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  if (s === undefined) return value;
  if (s.length <= MAX_LOG_VALUE_CHARS) return value;
  return `${s.slice(0, MAX_LOG_VALUE_CHARS)}…[truncated ${s.length - MAX_LOG_VALUE_CHARS} chars]`;
}

/** Log a tool/MCP invocation at INFO with `event: "tool_call"`. */
export function logToolCall(
  log: ToolLogger,
  { tool, kind, args }: { tool: string; kind: ToolKind; args: unknown },
): void {
  log.info(
    { event: "tool_call", tool, kind, arguments: truncateForLog(args) },
    `tool call: ${tool}`,
  );
}

/**
 * Log a tool/MCP result with `event: "tool_result"` — INFO when `ok`, WARN
 * otherwise (an errored call is still captured, but keeps warn severity).
 */
export function logToolResult(
  log: ToolLogger,
  {
    tool,
    kind,
    ok,
    result,
    error,
    durationMs,
  }: {
    tool: string;
    kind: ToolKind;
    ok: boolean;
    result?: unknown;
    error?: unknown;
    durationMs: number;
  },
): void {
  const fields: Record<string, unknown> = {
    event: "tool_result",
    tool,
    kind,
    ok,
    durationMs,
  };
  if (result !== undefined) fields.result = truncateForLog(result);
  if (error !== undefined && error !== null) fields.error = error;
  if (ok) log.info(fields, `tool result: ${tool}`);
  else log.warn(fields, `tool error: ${tool}`);
}
