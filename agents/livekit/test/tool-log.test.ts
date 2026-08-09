import { test } from "node:test";
import assert from "node:assert/strict";
import { logToolCall, logToolResult, truncateForLog } from "../lib/tool-log.js";

// Unit tests for the tool-call/result InvocationLog convention shared with the
// pipecat worker's tool_log.py. Pure / SDK-free (the helpers take any logger
// with info/warn): run with `node --import tsx --test test/tool-log.test.ts`.

interface Logged {
  level: "info" | "warn";
  obj: Record<string, unknown>;
  msg?: string;
}

function fakeLogger() {
  const lines: Logged[] = [];
  return {
    lines,
    info: (obj: object, msg?: string) =>
      lines.push({ level: "info", obj: obj as Record<string, unknown>, msg }),
    warn: (obj: object, msg?: string) =>
      lines.push({ level: "warn", obj: obj as Record<string, unknown>, msg }),
  };
}

test("logToolCall emits an info tool_call with the shared marker fields", () => {
  const log = fakeLogger();
  logToolCall(log, {
    tool: "get_weather",
    kind: "function",
    args: { q: "London" },
  });
  assert.equal(log.lines.length, 1);
  const [line] = log.lines;
  assert.equal(line.level, "info"); // visible at the prod `info` capture level
  assert.equal(line.obj.event, "tool_call"); // the distinguishing marker
  assert.equal(line.obj.tool, "get_weather");
  assert.equal(line.obj.kind, "function");
  assert.deepEqual(line.obj.arguments, { q: "London" });
  assert.equal(line.msg, "tool call: get_weather");
});

test("logToolResult(ok) emits an info tool_result with result + durationMs", () => {
  const log = fakeLogger();
  logToolResult(log, {
    tool: "get_weather",
    kind: "function",
    ok: true,
    result: "sunny",
    durationMs: 12,
  });
  const [line] = log.lines;
  assert.equal(line.level, "info");
  assert.equal(line.obj.event, "tool_result");
  assert.equal(line.obj.ok, true);
  assert.equal(line.obj.result, "sunny");
  assert.equal(line.obj.durationMs, 12);
  assert.equal(line.msg, "tool result: get_weather");
});

test("logToolResult(error) logs at warn but keeps the tool_result marker", () => {
  const log = fakeLogger();
  logToolResult(log, {
    tool: "do_thing",
    kind: "builtin",
    ok: false,
    error: "boom",
    durationMs: 3,
  });
  const [line] = log.lines;
  // warn is still >= the info capture level, so an errored call stays visible
  // in the debug log while keeping its severity.
  assert.equal(line.level, "warn");
  assert.equal(line.obj.event, "tool_result");
  assert.equal(line.obj.ok, false);
  assert.equal(line.obj.error, "boom");
  assert.equal(line.obj.kind, "builtin");
  assert.equal(line.msg, "tool error: do_thing");
});

test("logToolCall carries the subagent kind for agent-to-agent delegation", () => {
  const log = fakeLogger();
  logToolCall(log, {
    tool: "insurance-checker",
    kind: "subagent",
    args: { question: "is this covered?" },
  });
  const [line] = log.lines;
  assert.equal(line.obj.event, "tool_call");
  assert.equal(line.obj.kind, "subagent"); // splits agent delegation out of `builtin`
  assert.equal(line.msg, "tool call: insurance-checker");
});

test("truncateForLog returns small values structured and caps large ones", () => {
  const small = { a: 1 };
  assert.equal(truncateForLog(small), small); // same reference: logged structured

  const big = "x".repeat(8000 + 500);
  const out = truncateForLog(big);
  assert.equal(typeof out, "string");
  assert.ok((out as string).includes("[truncated 500 chars]"));
  assert.ok((out as string).length < big.length);
});
