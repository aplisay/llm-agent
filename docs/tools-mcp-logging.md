# Tool & MCP call logging

How every LLM **tool call**, **MCP entrypoint call**, and its **result** is logged
so it can be isolated from the rest of a call's log output. Written for engineers
consuming the logs (dashboards, debugging, log queries) and for anyone extending
or re-implementing a voice worker who must preserve the contract.

The logs land in the per-call **InvocationLog** ("debug log", subsystems
`livekit-agent` / `pipecat-agent`) alongside every other worker log line. The
convention below is what makes tool/MCP activity greppable within that stream.

## 1. The contract

Two log lines per tool/MCP call — one when it is invoked, one when it returns —
each carrying a stable `event` marker plus a fixed set of structured fields. The
shape is **identical across livekit and pipecat**, so entries correlate 1:1
across subsystems.

| field        | `event: "tool_call"` | `event: "tool_result"`                    |
|--------------|----------------------|-------------------------------------------|
| `event`      | `"tool_call"`        | `"tool_result"`                           |
| `tool`       | tool name (MCP tools are server-namespaced) | same             |
| `kind`       | `function` \| `builtin` \| `mcp` \| `subagent` | same            |
| `arguments`  | model-supplied args  | —                                         |
| `ok`         | —                    | `true` on success, `false` otherwise      |
| `result`     | —                    | result returned to the model (when `ok`)  |
| `error`      | —                    | error string (when not `ok`)              |
| `durationMs` | —                    | elapsed milliseconds                      |

`event` is the **only field you need to isolate these logs**. `tool`/`kind` narrow
further (e.g. `kind == "mcp"` for MCP entrypoint calls only).

Notes:
- **Redaction & safety.** `arguments` are the model's own arguments (never the
  `source: static`/`metadata`-injected values — those are resolved *inside* the
  handler, downstream of the log point). `result` is what the model sees, so a
  `redact`-flagged function logs its redacted `OK`/`FAILED`, not the raw payload.
- **Truncation.** `arguments` and `result` are capped at 8000 chars (a large REST
  or MCP payload is truncated with an explicit `…[truncated N chars]` marker) so
  one call cannot dominate the size-bounded InvocationLog.

## 2. How to isolate them

**In the raw worker log stream** (pino JSON for livekit, loguru for pipecat) or in
a persisted InvocationLog entry, filter on the `event` field:

```
event == "tool_call" || event == "tool_result"      # all tool + MCP activity
event == "tool_result" && ok == false               # failures only
event in ("tool_call","tool_result") && kind == "mcp"  # MCP entrypoint calls only
```

- **livekit** — pino puts bound fields at the top level of each JSON line, so
  `.event` is a top-level key.
- **pipecat** — loguru bound fields land under the pino-shaped entry's `extra`
  object (`entry.extra.event`); `callId`, `level`, `msg` are top-level. See
  `pipecat_aplisay/invocation_log.py::_record_to_entry`.
- **Message fallback.** If you only have the rendered message string, the prefixes
  are stable: `tool call: <name>`, `tool result: <name>`, `tool error: <name>`,
  `tool cancelled: <name>`.

## 3. Levels & capture

Everything is emitted at a level that the production capture threshold (`info`)
keeps, so tool activity is visible for production agents without turning on debug:

| outcome                                   | level     | still captured? |
|-------------------------------------------|-----------|-----------------|
| `tool_call`, successful `tool_result`     | `info`    | yes             |
| errored `tool_result` (`ok: false`)       | `warning` | yes (≥ info), keeps severity |
| cancelled protected builtin               | `info`    | yes             |

Capture thresholds: livekit pino sits at `info` in prod (`LOGLEVEL` unset);
pipecat's capture sink is `LOGLEVEL` (default `INFO`). Do **not** emit tool logs
at `debug` — they will be dropped in production.

## 4. Where it is emitted

Instrument the **single tool-dispatch choke point** each worker already has, and
only through the **capturing** logger. Both workers funnel every registered tool —
the agent's own `functions`, platform `builtins`, and MCP tools — through one
callback, so one pair of log lines there covers everything.

| worker  | choke point                                           | helper                                   |
|---------|-------------------------------------------------------|------------------------------------------|
| livekit | `agents/livekit/lib/agent-tools.ts` → `execute`       | `agents/livekit/lib/tool-log.ts`         |
| pipecat | `pipecat_aplisay/voice_session.py` → `_runner`        | `pipecat_aplisay/tool_log.py`            |

`kind` is derived at descriptor-build time: livekit from the function's
`implementation` (`builtin` vs `function`); pipecat tags descriptors in
`agent_tools.py` (`function`/`builtin`) and `mcp_tools.py` (`mcp`). Both workers
special-case the `subagent` builtin (`platform == "subagent"`) as `kind ==
"subagent"` — a delegation to a headless `text` agent, split out from the generic
`builtin` so agent-to-agent calls read as their own category.

Two constraints that are easy to get wrong:

- **livekit — use the capturing logger.** Logs emitted inside the shared
  `agent-lib/function-handler.js` use a *different, non-capturing* pino instance
  and never reach the InvocationLog buffer. Instrument in `agents/livekit/lib/*`
  (which imports the capturing `./logger.js`), i.e. at the `execute` choke point —
  not in the shared handler.
- **pipecat — stay inside the call context.** The capture sink only buffers
  records emitted within `logger.contextualize(callId=…)` (set for the whole
  pipeline run in `CallSession._run_prepared_once`). Tool execution runs inside
  that scope, so the helper works; the same dependency governs every other
  in-call log line.

## 5. Coverage

- **pipecat** covers `function` + `builtin` + `subagent` + `mcp` — MCP servers are
  proxied in-worker (`mcp_tools.py`), so MCP entrypoint calls appear in the debug
  log.
- **livekit** covers `function` + `builtin` + `subagent`. The livekit **voice** worker executes
  no in-worker MCP: the pipeline LLM is a native LiveKit provider plugin
  (`buildProviderPipelineLlm`), not the `lib/models/*` drivers, and MCP
  (`McpToolBridge`) only runs in the text/model path — a different process. There
  is therefore no `kind == "mcp"` line from a livekit voice call; that is a
  property of the architecture, not a logging gap.

## 6. Extending / preserving parity

When you add a tool kind, a builtin, or a whole new worker:

1. Emit **only** via the shared helper (`tool-log.ts` / `tool_log.py`) at the tool
   choke point — do not hand-roll tool logs elsewhere.
2. Keep the field names and `event` values above; do not rename them. Consumers
   filter on `event`/`kind` across subsystems.
3. Give every descriptor a `kind`; add a new value only if the coarse
   `function`/`builtin`/`mcp`/`subagent` set genuinely does not fit.
4. Keep the two-line call/result pairing and the level table in §3.

Tests that lock this in: `agents/livekit/test/tool-log.test.ts`,
`agents/pipecat/tests/test_tool_log.py` (the pipecat one drives the real capture
sink at `info` to prove the markers land in the InvocationLog).
