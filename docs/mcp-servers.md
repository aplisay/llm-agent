# Remote MCP Servers on Agents (`mcpServers`)

> Status: experimental. Whether an agent honours `mcpServers` depends on its
> **model**, indicated by the `supportsMcp` flag on `GET /models`. Two runtimes
> honour it today:
>
> - **`text:anthropic/…` text agents** — via the **Anthropic MCP connector**.
>   Anthropic runs the MCP client server-side as part of each model completion,
>   so a headless text agent (including a `subagent`) can read remote MCP servers
>   with no call session involved. This is the recommended way to give an agent
>   team access to an MCP **knowledgebase** (see below).
> - **`pipecat:` voice models** — via the **Pipecat worker**, which acts as the
>   MCP client for the duration of a live call.
>
> Other handlers (`livekit:`, `ultravox:`, `jambonz:`, and non-Anthropic `text:`
> models such as `text:openai/…`) currently **store the property but ignore it**
> — the definition is kept so the agent can be moved to an MCP-capable model
> later. Always check `supportsMcp` on `GET /models` for what your chosen model
> honours; never assume a handler supports MCP because another one does.

Agents can be given remote [MCP (Model Context Protocol)](https://modelcontextprotocol.io)
servers whose tools are exposed to the LLM as additional callable tools,
alongside any `functions`. Something acts as the MCP **client** — it connects to
each configured server, discovers its tools, hands their schemas to the model,
and proxies every invocation — but *what* plays that role, and *when*, differs by
runtime (see [Runtime behaviour](#runtime-behaviour)).

## Configuring

`mcpServers` is a top-level agent property (sibling of `functions`), accepted on
`POST /agents`, `PUT /agents/{agentId}`, and on [agent-set](./multi-agent-api.md)
member definitions. The same shape applies to voice (`pipecat:`) and text
(`text:anthropic/…`) agents:

```json
{
  "name": "Knowledge",
  "modelName": "text:anthropic/claude-sonnet-4-6",
  "prompt": "You answer product questions using the docs tools, then call result.",
  "mcpServers": [
    {
      "name": "docs",
      "url": "https://mcp.example.com/mcp",
      "transport": "streamable_http",
      "headers": { "Authorization": "Bearer sk-…" }
    }
  ],
  "functions": [ { "…": "ordinary functions work alongside MCP tools" } ]
}
```

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Identifier for the server (`^[a-zA-Z0-9_-]{1,64}$`). Used to namespace its tool names. |
| `url` | Yes | Base URL of the remote MCP endpoint. |
| `transport` | No | `streamable_http` (default) or `sse`. |
| `key` | No | The `name` of an entry in the agent's `keys` array used to authenticate to this server — the recommended way to supply a credential, because `keys` values are write-only (never returned by the API). The Pipecat worker resolves any key type (`bearer`/`basic`/`header`/`query`); the Anthropic connector resolves **`bearer` keys only**, into the connector's authorization token (other key types are skipped with a warning). |
| `headers` | No | HTTP headers sent on every request — typically an `Authorization` bearer token. Honoured by the Pipecat worker only; the Anthropic connector ignores `headers` (use `key` instead — a public server such as the Aplisay knowledgebase needs neither). Prefer `key` for secrets: values set in `headers` are stored on the agent and returned to clients verbatim. |

## Runtime behaviour

There are two MCP client runtimes; which one applies is determined by the model:

- **Text (`text:anthropic/…`) — Anthropic MCP connector.** The MCP client is
  Anthropic's API, not the Aplisay platform. On each model completion the
  connector connects to the configured servers, exposes their tools, executes any
  the model calls server-side, and returns the results in the same completion.
  Because there is no call session, this works for **headless** text agents
  invoked via `POST /agents/{id}/invoke`, run as a `subagent`, or driven turn by
  turn over `POST /agents/{id}/chat`. To authenticate to a server, set
  `mcpServers[].key` to the name of a `bearer` entry in the agent's `keys`: the
  platform resolves it into the connector's authorization token at completion
  time, so the secret never appears in an org-readable agent field. Non-`bearer`
  key types are not supported on this path and are skipped with a warning.
- **Voice (`pipecat:`) — Pipecat worker.** The platform worker is the MCP
  client: connections are opened when the call session starts and closed at
  teardown, so tools added or removed on the remote server are picked up by the
  next call.

Common to both:

- **Tool naming**: each remote tool is exposed to the model under a name derived
  from its server (`<serverName>_<toolName>`, sanitised to `[A-Za-z0-9_]`), so
  two servers can both expose a `search` tool and MCP tools never collide with
  the agent's own `functions`.
- **Invocation**: tool calls are proxied to the server and the text content of
  the result is returned to the model. All MCP tool parameters are
  model-`generated` — there is no `static`/`metadata` source resolution, no
  `redact` support, and results are **not** written into `metadata.toolsCalls`
  (those are features of platform `functions`).
- **Failure isolation**: a misconfigured or unreachable server is reported to the
  model as an error result rather than taking the turn down, so the conversation
  can recover.

## Model support

`GET /models` includes a `supportsMcp` flag per model — the single source of
truth. Today it is `true` for `pipecat:` voice models and `text:anthropic/…`
text models; it is `false` (stored but ignored) for `livekit:`, `ultravox:`,
`jambonz:`, and non-Anthropic `text:` models. The definition is stored either
way, so an agent can be moved to an MCP-capable model later.

## MCP-backed knowledgebases (recommended pattern)

To give a **team** of agents access to an MCP knowledgebase, the robust pattern
is a dedicated **`text:anthropic/…` knowledge subagent** with the knowledgebase
in its `mcpServers`, invoked by the others through the builtin `subagent`
function:

```json
{
  "label": "knowledge",
  "name": "Knowledge",
  "modelName": "text:anthropic/claude-sonnet-4-6",
  "prompt": "Answer the question using the knowledgebase tools, then call result with a concise answer.",
  "mcpServers": [ { "name": "kb", "url": "https://mcp.example.com/mcp", "transport": "streamable_http" } ],
  "functions": [ { "name": "result", "implementation": "builtin", "platform": "result", "input_schema": { "properties": { "answer": { "type": "string" } } } } ]
}
```

Why this rather than putting `mcpServers` directly on the voice agent:

- It works **regardless of the calling agent's runtime** — a `livekit:` voice
  agent (which ignores `mcpServers` itself) can still consult the knowledgebase
  by calling the text subagent, because the subagent runs on `text:anthropic/…`
  where the connector is active.
- The knowledge specialist is **maintained in one place** and shared by every
  voice agent in the set.
- It returns a **structured `result`** rather than dumping raw tool output into
  the live conversation, and can be tested in isolation via
  `POST /agents/{id}/invoke`.

## Choosing between `functions`, `subagent`, and `mcpServers`

- **`functions` (`rest`)** — you control the HTTP contract; parameters can be
  pinned (`static`) or taken from call metadata; results feed
  `metadata.toolsCalls` chaining and `redact`.
- **`mcpServers`** — the remote service defines its own tool catalogue and
  schemas; zero per-tool configuration, ideal when you operate (or buy) an MCP
  server that already models the domain, and the agent runs on an MCP-capable
  model (`text:anthropic/…` or `pipecat:`).
- **`subagent`** — the "tool" is itself an LLM agent that reasons over its own
  tools (which can include `mcpServers`) and returns a structured result; this is
  how a voice agent on any handler reaches an MCP knowledgebase. See
  [`multi-agent-api.md`](./multi-agent-api.md).
