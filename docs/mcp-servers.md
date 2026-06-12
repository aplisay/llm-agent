# Remote MCP Servers on Agents (`mcpServers`)

> Status: experimental. Runtime support is currently provided by the **Pipecat
> worker** (`pipecat:` models); other handlers store but ignore the property.
> Check `supportsMcp` on `GET /models` for what your deployment honours.

Agents can be given remote [MCP (Model Context Protocol)](https://modelcontextprotocol.io)
servers whose tools are exposed to the LLM as additional callable tools,
alongside any `functions`. The platform worker acts as the MCP **client**: at
call setup it connects to each configured server, discovers its tools, hands
their schemas to the model, and proxies every invocation for the lifetime of
the call.

## Configuring

`mcpServers` is a top-level agent property (sibling of `functions`), accepted on
`POST /agents`, `PUT /agents/{agentId}`, and on [agent-set](./multi-agent-api.md)
member definitions:

```json
{
  "name": "Concierge",
  "modelName": "pipecat:ultravox/ultravox-v0.7",
  "prompt": "You are a hotel concierge…",
  "mcpServers": [
    {
      "name": "bookings",
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
| `headers` | No | HTTP headers sent on every request — typically an `Authorization` bearer token. |

## Runtime behaviour

- **Discovery per call**: connections are opened when the call session starts
  and closed at teardown. Tools added or removed on the remote server are
  picked up by the next call.
- **Tool naming**: each remote tool is exposed to the LLM as
  `<serverName>_<toolName>` (sanitised to `[A-Za-z0-9_]`, max 64 chars), so two
  servers can both expose a `search` tool, and MCP tools can never collide with
  the agent's own `functions`.
- **Invocation**: tool calls are proxied to the server verbatim and the text
  content of the result is returned to the model. All MCP tool parameters are
  LLM-`generated` — there is no `static`/`metadata` source resolution, no
  `redact` support, and results are **not** written into `metadata.toolsCalls`
  (those are features of platform `functions`).
- **Failure isolation**: a misconfigured or unreachable server is skipped with
  a warning at call setup; one bad server never takes the call down. A tool
  call that fails server-side returns an error result to the model so the
  conversation can recover.

## Model support

`GET /models` includes a `supportsMcp` flag per model. Models that do not
advertise it silently ignore the `mcpServers` property (the definition is
stored either way, so an agent can be moved to an MCP-capable model later).

## Choosing between `functions`, `subagent`, and `mcpServers`

- **`functions` (`rest`)** — you control the HTTP contract; parameters can be
  pinned (`static`) or taken from call metadata; results feed
  `metadata.toolsCalls` chaining and `redact`.
- **`mcpServers`** — the remote service defines its own tool catalogue and
  schemas; zero per-tool configuration, ideal when you operate (or buy) an MCP
  server that already models the domain.
- **`subagent`** — the "tool" is itself an LLM agent that reasons over its own
  tools and returns a structured result; see
  [`multi-agent-api.md`](./multi-agent-api.md).
