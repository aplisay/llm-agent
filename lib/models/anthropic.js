import Llm from './llm.js';
import { Anthropic as AnthropicSdk } from '@anthropic-ai/sdk';
const { ANTHROPIC_API_KEY } = process.env;

// Bound every Messages API call. The SDK default timeout is 10 minutes, so a
// stalled MCP-connector round trip would hang a chat turn silently (no error,
// spinner stuck) for that long. With this, a stall surfaces as a fast, visible
// error instead. Retries kept low so a timeout doesn't compound. Both env-tunable.
const REQUEST_TIMEOUT_MS = Number(process.env.ANTHROPIC_REQUEST_TIMEOUT_MS || 90000);
const MAX_RETRIES = Number(process.env.ANTHROPIC_MAX_RETRIES ?? 1);

const anthropic = new AnthropicSdk({ timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });

// Beta header for the Messages API MCP connector (remote MCP servers executed
// server-side). See platform docs: agents-and-tools/mcp-connector.
const MCP_BETA = 'mcp-client-2025-11-20';
// Safety cap on server-side (pause_turn) continuations within one completion.
const MAX_SERVER_HOPS = 6;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Implements the LLM class against current Anthropic Claude models via the
 * Messages API. Used by `text:anthropic/...` agents (text-agent invoke,
 * subagent, and the interactive chat session) — it is not wired into any voice
 * handler. Honours top-level `mcpServers` through the native MCP connector so a
 * text agent can read remote MCP servers (e.g. the Aplisay docs/API) at call
 * time.
 *
 * The `completion` / `callResult` contract and the `{ text, calls }` return
 * shape are unchanged, where `calls` are client-executed tool calls; MCP tools
 * are executed server-side by Anthropic and never surface as `calls`.
 *
 * @class Anthropic
 * @extends {Llm}
 */
class Anthropic extends Llm {

  // Offered text models: the current release plus the last two prior *active*
  // versions of each family (Opus has three; Sonnet three; Haiku only one is
  // current — its older versions are deprecated/retired). Keep Opus 4.8 first:
  // it is the no-model fallback in the constructor. Bare ids only — the
  // `text:anthropic/` prefix is added by the handler; verify against the
  // Anthropic model catalogue before adding (a wrong id 400s at call time).
  static allModels = [
    ["claude-opus-4-8", "Anthropic Claude Opus 4.8"],
    ["claude-opus-4-7", "Anthropic Claude Opus 4.7"],
    ["claude-opus-4-6", "Anthropic Claude Opus 4.6"],
    ["claude-sonnet-5", "Anthropic Claude Sonnet 5"],
    ["claude-sonnet-4-6", "Anthropic Claude Sonnet 4.6"],
    ["claude-sonnet-4-5", "Anthropic Claude Sonnet 4.5"],
    ["claude-haiku-4-5", "Anthropic Claude Haiku 4.5"],
  ].map(([name, description]) => ([`${this.name.toLowerCase()}/${name}`, description]));

  static get needKey() {
    return { ANTHROPIC_API_KEY };
  }

  static supportsFunctions = () => true;

  // This implementation honours top-level mcpServers via the MCP connector.
  static supportsMcp = () => true;

  // Vendor label for usage metering (see lib/usage.js).
  static provider = 'anthropic';

  constructor({ logger, prompt, options, model, mcpServers }) {
    super(...arguments);
    this.mcpServers = Array.isArray(mcpServers) ? mcpServers : [];
    this.model = model || Anthropic.allModels[0][0];
    this.gpt = {
      ...(this.gpt || {}),
      // Note: temperature/top_p are intentionally omitted — current Claude
      // models (Opus 4.x etc.) reject them.
      max_tokens: options?.maxTokens || DEFAULT_MAX_TOKENS,
      system: prompt,
      messages: [],
    };
    logger.debug({ prompt, model: this.gpt.model, mcpServers: this.mcpServers.length }, 'NEW Anthropic agent');
  }

  set prompt(newPrompt) {
    this._prompt = newPrompt;
    this.gpt && (this.gpt.system = this._prompt);
  }
  get prompt() { return this._prompt; }

  // functions: the portable definitions; tools: the LLM-facing definitions.
  set functions(functions) {
    this._functions = functions;
    this.tools = (functions || []).map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }
  get functions() { return this._functions; }

  set options(newOptions) { this._options = newOptions; }
  get options() { return this._options; }

  async initial(callBack) {
    this.logger.debug({ callBack }, 'Anthropic initial');
    return this.rawCompletion('hello', callBack);
  }

  /**
   * MCP servers usable on THIS call: a keyed server whose token can't be
   * resolved is dropped entirely. Sending it without `authorization_token`
   * guarantees the connector a 401 and the WHOLE request a hard 400
   * ("Authentication error while communicating with MCP server"), taking the
   * turn down; dropping it merely degrades that server's tools for the turn.
   */
  activeMcpServers() {
    return this.mcpServers.filter((s) => {
      if (!s.key || this.serverAuthToken(s)) return true;
      this.logger.warn({ server: s.name, key: s.key },
        'mcpServers key reference unresolved — dropping server for this call');
      return false;
    });
  }

  /** Client function tools plus one mcp_toolset per usable MCP server. */
  toolsParam(mcpServers = this.mcpServers) {
    const tools = [...(this.tools || [])];
    mcpServers.forEach((s) => tools.push({ type: 'mcp_toolset', mcp_server_name: s.name }));
    return tools;
  }

  /**
   * The MCP connector auth token for one configured server: an explicit
   * `authorization_token` (legacy, org-readable) wins; otherwise a `key`
   * reference is resolved against the agent's write-only `keys` — only a
   * bearer key makes sense as a connector token, anything else is skipped
   * with a debug warning. Returns undefined when the server needs no auth.
   */
  serverAuthToken(server) {
    if (server.authorization_token) return server.authorization_token;
    if (!server.key) return undefined;
    const key = (this.keys || []).find((k) => k.name === server.key);
    if (key?.in === 'bearer') return key.value;
    this.logger.debug({ server: server.name, key: server.key, in: key?.in },
      'mcpServers key reference is missing or not a bearer key, skipping');
    return undefined;
  }

  /** One Messages API call against the current conversation; MCP connector when configured. */
  async create() {
    const mcpServers = this.activeMcpServers();
    const tools = this.toolsParam(mcpServers);
    // Send the (static, re-sent every round) system prompt as a content block
    //  with an ephemeral cache_control breakpoint so successive rounds of the
    //  same conversation hit the prompt cache rather than re-billing it in full.
    const system = this.gpt.system
      ? [{ type: 'text', text: this.gpt.system, cache_control: { type: 'ephemeral' } }]
      : undefined;
    const request = {
      model: this.gpt.model,
      max_tokens: this.gpt.max_tokens,
      ...(system ? { system } : {}),
      messages: this.gpt.messages,
      ...(tools.length ? { tools } : {}),
    };
    if (mcpServers.length) {
      return anthropic.beta.messages.create({
        ...request,
        mcp_servers: mcpServers.map((s) => {
          const token = this.serverAuthToken(s);
          return {
            type: 'url',
            url: s.url,
            name: s.name,
            ...(token ? { authorization_token: token } : {}),
          };
        }),
        betas: [MCP_BETA],
      });
    }
    return anthropic.messages.create(request);
  }

  /**
   * Generate the next round of chat response. Resumes through `pause_turn`
   * (server-side MCP tools mid-flight) and returns once the model either
   * finishes or asks for a client tool.
   *
   * @param {string|null} input user text for this turn, or null to continue
   * @returns {Promise<{text:string, calls:Array}>}
   */
  async rawCompletion(input, callBack) {
    if (input) {
      this.gpt.messages.push({ role: 'user', content: input });
    }
    let text = '';
    let calls = [];
    let lastStopReason = null;
    // Token usage accumulated across all hops of this completion (a pause_turn
    //  MCP round trip can span several Messages API calls).
    const usage = { provider: 'anthropic', model: this.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (let hop = 0; hop < MAX_SERVER_HOPS; hop += 1) {
      const message = await this.create();
      const { content = [], role = 'assistant', stop_reason, usage: u } = message;
      if (u) {
        usage.inputTokens += u.input_tokens || 0;
        usage.outputTokens += u.output_tokens || 0;
        usage.cacheReadTokens += u.cache_read_input_tokens || 0;
        usage.cacheWriteTokens += u.cache_creation_input_tokens || 0;
      }
      lastStopReason = stop_reason;
      text += content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      // Surface server-executed MCP tool calls so a caller can show progress
      // during the (slow) connector round trips — and log them, so a turn that
      // spends minutes browsing the MCP is visible in the server log rather than
      // looking like a hang.
      const mcpUses = content.filter((b) => b.type === 'mcp_tool_use');
      mcpUses.forEach((b) => {
        this.logger.info({ tool: b.name, server: b.server_name }, 'anthropic MCP tool use');
        callBack && callBack({ mcp_tool_use: { name: b.name, server: b.server_name } });
      });
      // Preserve the full assistant content (text + any mcp_tool_use/result +
      // tool_use blocks) so the connector and tool loop keep their context.
      this.gpt.messages.push({ role, content });
      const toolUses = content.filter((b) => b.type === 'tool_use');
      this.logger.info(
        { hop, stop_reason, mcpToolUses: mcpUses.length, toolUses: toolUses.length, textLen: text.length },
        'anthropic completion hop');
      if (stop_reason === 'pause_turn') continue;
      calls = toolUses.map(({ name, id, input: args }) => ({ name, id, input: args }));
      break;
    }
    // `truncated`: the model hit its output-token ceiling (stop_reason
    // "max_tokens"). If it was mid tool-call, the tool's arguments are
    // incomplete — a large field (e.g. an agents array) is cut off and lost,
    // leaving only the leading keys. Callers must treat such a call as failed-
    // by-truncation rather than dispatching its mangled arguments.
    const result = { text, calls, truncated: lastStopReason === 'max_tokens', usage };
    callBack && callBack(result);
    return result;
  }

  /**
   * Send client tool-call results back to generate the next round.
   * @param {Array<{id:string, result:string}>} results
   */
  async callResult(results, callBack) {
    this.gpt.messages.push({
      role: 'user',
      content: results.map(({ id, result }) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: result,
      })),
    });
    return this.rawCompletion(null, callBack);
  }
}

export default Anthropic;
