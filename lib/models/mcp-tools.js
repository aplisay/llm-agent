/**
 * Client-side MCP tool bridge for drivers whose provider has no server-side
 * MCP connector (everything except Anthropic's Messages API and OpenAI's
 * Responses API). Connects to each of the agent's `mcpServers` over Streamable
 * HTTP, exposes their tools under provider-safe names, and executes calls —
 * so an agent built for the Anthropic driver (e.g. the set builder with its
 * aplisay/polite/knowledge servers) behaves the same on Kimi/OpenRouter/
 * Gemini.
 *
 * Auth mirrors lib/models/anthropic.js: an explicit `authorization_token`
 * wins; otherwise `key` names a write-only Agent.keys bearer entry. A server
 * whose key can't be resolved is DROPPED for the session (degrade one
 * server's tools, never fail the whole chat) — the same desync posture as the
 * Anthropic connector path.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// OpenAI-compatible providers enforce ^[a-zA-Z0-9_-]{1,64}$ on function
// names; MCP names are looser, so bridge names are sanitised + deduped.
const NAME_RE = /[^a-zA-Z0-9_-]/g;

export class McpToolBridge {
  constructor({ mcpServers, keys, logger }) {
    this.servers = Array.isArray(mcpServers) ? mcpServers : [];
    this.keys = Array.isArray(keys) ? keys : [];
    this.logger = logger;
    this.clients = new Map();   // server name → connected Client
    this.byExposedName = new Map(); // exposed name → { client, server, tool }
    this.tools = [];            // [{ name, description, input_schema }]
    this.ready = null;
  }

  /** Bearer for one server, or undefined (no auth) / null (unresolvable). */
  authFor(server) {
    if (server.authorization_token) return server.authorization_token;
    if (!server.key) return undefined;
    const key = this.keys.find((k) => k.name === server.key);
    if (key?.in === 'bearer') return key.value;
    return null;
  }

  /** Connect all usable servers and build the merged tool list (once). */
  ensure() {
    if (!this.ready) this.ready = this.connectAll();
    return this.ready;
  }

  async connectAll() {
    for (const server of this.servers) {
      const token = this.authFor(server);
      if (token === null) {
        this.logger.warn({ server: server.name, key: server.key },
          'mcp bridge: key reference unresolved — dropping server for this session');
        continue;
      }
      try {
        const transport = new StreamableHTTPClientTransport(new URL(server.url), {
          ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
        });
        const client = new Client({ name: 'aplisay-llm-agent', version: '1.0.0' });
        await client.connect(transport);
        const { tools } = await client.listTools();
        this.clients.set(server.name, client);
        for (const tool of tools || []) {
          let exposed = `${server.name}_${tool.name}`.replace(NAME_RE, '_').slice(0, 64);
          let n = 2;
          while (this.byExposedName.has(exposed)) {
            exposed = `${exposed.slice(0, 61)}_${n}`;
            n += 1;
          }
          this.byExposedName.set(exposed, { client, server: server.name, tool: tool.name });
          this.tools.push({
            name: exposed,
            description: tool.description || `${tool.name} (via ${server.name})`,
            input_schema: tool.inputSchema || { type: 'object', properties: {} },
          });
        }
        this.logger.info({ server: server.name, tools: (tools || []).length }, 'mcp bridge: server connected');
      } catch (e) {
        // One unreachable server degrades that server only — matching the
        // Anthropic connector's drop semantics rather than failing the chat.
        this.logger.error({ server: server.name, err: e?.message }, 'mcp bridge: connect failed — dropping server');
      }
    }
    return this.tools;
  }

  isMcpTool(name) {
    return this.byExposedName.has(name);
  }

  /**
   * Execute one bridged call; always resolves to a result STRING (execution
   * failures come back as an ERROR-prefixed string for the model to read —
   * the MCP contract puts tool failures in-band, not as exceptions).
   */
  async call(name, args, callBack) {
    const entry = this.byExposedName.get(name);
    if (!entry) return `ERROR: unknown MCP tool ${name}`;
    callBack && callBack({ mcp_tool_use: { name: entry.tool, server: entry.server } });
    try {
      const result = await entry.client.callTool({ name: entry.tool, arguments: args || {} });
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      return result.isError ? `ERROR: ${text || 'tool failed'}` : (text || JSON.stringify(result.structuredContent ?? ''));
    } catch (e) {
      this.logger.error({ tool: name, err: e?.message }, 'mcp bridge: call failed');
      return `ERROR: MCP call failed: ${e?.message}`;
    }
  }

  async close() {
    for (const client of this.clients.values()) {
      await client.close().catch(() => {});
    }
    this.clients.clear();
  }
}

export default McpToolBridge;
