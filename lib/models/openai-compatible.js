import OpenAI from 'openai';
import Llm from './llm.js';
import McpToolBridge from './mcp-tools.js';

// Hard ceiling on internal MCP round-trips within one completion (parity with
// the Anthropic connector's MAX_SERVER_HOPS).
const MAX_MCP_HOPS = 6;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Base driver for OpenAI-compatible chat-completions providers (Moonshot,
 * OpenRouter, Groq — anything that speaks POST /chat/completions with the
 * `openai` SDK pointed at a different baseURL). OpenAI itself does NOT use
 * this class: it runs on the Responses API (lib/models/openai.js).
 *
 * Contract fixes over the old axios driver: `options.maxTokens` is honoured
 * (the old driver hardcoded 1024 — every builder save truncated), errors are
 * THROWN so the chat loop can report and retry them (not swallowed into an
 * apology string with the usage lost), cached prompt tokens are read from the
 * provider's usage details, and top-level `mcpServers` are honoured through
 * the client-side MCP bridge (lib/models/mcp-tools.js) — bridged tools are
 * executed inside this driver and never surface as client calls.
 *
 * @class OpenAiCompatible
 * @extends {Llm}
 */
class OpenAiCompatible extends Llm {

  static supportsFunctions = () => true;
  // MCP via the client-side bridge — parity with the Anthropic connector.
  static supportsMcp = () => true;

  /** Subclasses override: API base URL. */
  static baseURL = 'https://api.openai.com/v1';
  /** Subclasses override: env var carrying the API key. */
  static apiKeyEnv = 'OPENAI_API_KEY';
  /** Extra default headers (e.g. OpenRouter attribution). */
  static extraHeaders = undefined;
  /** Request field for the completion-token cap ('max_tokens' | 'max_completion_tokens'). */
  static maxTokensParam = 'max_completion_tokens';
  /**
   * Whether options.temperature may be forwarded. Reasoning-tier models on
   * several providers hard-reject custom sampling (Moonshot k2.x errors on
   * it), so the safe default is to omit unless a subclass opts in.
   */
  static allowTemperature = false;

  static provider = 'openai';

  constructor({ logger, prompt, options, model, modelName, mcpServers, keys }) {
    super(...arguments);
    const apiKey = process.env[this.constructor.apiKeyEnv];
    // Fail CLOSED on a missing key: with apiKey undefined the openai SDK's
    // own default kicks in and reads OPENAI_API_KEY from the env — which
    // would send OpenAI's secret to this provider's host as a Bearer.
    if (!apiKey) {
      throw new Error(`${this.constructor.name}: ${this.constructor.apiKeyEnv} is not set`);
    }
    this.client = new OpenAI({
      baseURL: this.constructor.baseURL,
      apiKey,
      ...(this.constructor.extraHeaders ? { defaultHeaders: this.constructor.extraHeaders } : {}),
      maxRetries: 1,
      timeout: Number(process.env.OPENAI_COMPAT_TIMEOUT_MS || 900000),
    });
    // Handler-constructed (voice) sessions spread agent.dataValues, which has
    // only modelName — without this fallback they'd silently run the catalogue
    // default instead of the agent's configured model.
    this.model = model || modelName || this.constructor.allModels[0][0];
    this.maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS;
    this.temperature = this.constructor.allowTemperature ? options?.temperature : undefined;
    this.mcp = new McpToolBridge({ mcpServers, keys, logger: this.logger });
    this.gpt = {
      ...(this.gpt || {}),
      messages: [{ role: 'system', content: prompt }],
    };
    logger.debug({ model: this.gpt.model, baseURL: this.constructor.baseURL }, `NEW ${this.constructor.name} agent`);
  }

  // Model ids on these providers can themselves contain '/'
  // (groq 'openai/gpt-oss-120b', openrouter 'moonshotai/kimi-k2.6') — strip
  // only OUR leading provider segment, not everything up to the last slash.
  set model(newModel) {
    this.gpt = { ...(this.gpt || {}), model: String(newModel).replace(/^[^/]+\//, '') };
  }
  get model() { return this.gpt.model; }

  set prompt(newPrompt) {
    this._prompt = newPrompt;
    const system = this.gpt?.messages?.find((m) => m.role === 'system');
    if (system) system.content = newPrompt;
  }
  get prompt() { return this._prompt; }

  set functions(functions) {
    this._functions = functions;
    this.tools = (functions || []).map(({ name, description, input_schema }) => ({
      type: 'function',
      function: { name, description, parameters: input_schema },
    }));
  }
  get functions() { return this._functions; }

  set options(newOptions) { this._options = newOptions; }
  get options() { return this._options; }

  async initial(callBack) {
    return this.rawCompletion('hello', callBack);
  }

  /** Bridged MCP tool defs merged after the agent's own functions. */
  async toolsParam() {
    const bridged = await this.mcp.ensure();
    return [
      ...(this.tools || []),
      ...bridged.map(({ name, description, input_schema }) => ({
        type: 'function',
        function: { name, description, parameters: input_schema },
      })),
    ];
  }

  /** Per-request body — subclasses may extend (e.g. OpenRouter reasoning). */
  requestBody(tools) {
    return {
      model: this.gpt.model,
      messages: this.gpt.messages,
      [this.constructor.maxTokensParam]: this.maxTokens,
      ...(tools.length ? { tools } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    };
  }

  /** Normalise a provider usage object onto the ledger shape. */
  usageOf(u) {
    // Moonshot reports top-level cached_tokens; OpenAI-shape providers nest
    // it under prompt_tokens_details (OpenRouter adds cache_write_tokens).
    const cacheReadTokens = u?.prompt_tokens_details?.cached_tokens ?? u?.cached_tokens ?? 0;
    return {
      // prompt_tokens INCLUDES the cached subset — report the uncached
      // remainder so the ledger units stay disjoint (a cache hit must not be
      // billed at the full input rate AND again at the cache-read rate).
      inputTokens: Math.max(0, (u?.prompt_tokens || 0) - cacheReadTokens),
      outputTokens: u?.completion_tokens || 0,
      cacheReadTokens,
      cacheWriteTokens: u?.prompt_tokens_details?.cache_write_tokens ?? 0,
    };
  }

  /**
   * One round: send, execute any bridged MCP calls internally (looping), and
   * return once the model produces text and/or CLIENT tool calls.
   */
  async rawCompletion(input, callBack) {
    if (input) this.gpt.messages.push({ role: 'user', content: input });
    const tools = await this.toolsParam();
    const usage = {
      provider: this.constructor.provider, model: this.model,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    };
    let text = '';
    let truncated = false;
    let clientCalls = [];

    try {
      for (let hop = 0; hop < MAX_MCP_HOPS; hop += 1) {
        const completion = await this.client.chat.completions.create(this.requestBody(tools));
        const choice = completion.choices?.[0];
        if (!choice) throw new Error(`${this.constructor.name}: empty completion`);
        const u = this.usageOf(completion.usage);
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
        usage.cacheReadTokens += u.cacheReadTokens;
        usage.cacheWriteTokens += u.cacheWriteTokens;
        truncated = choice.finish_reason === 'length';
        // Push the assistant message WHOLE — reasoning_content (Moonshot) /
        // reasoning_details (OpenRouter) must ride the history in tool loops.
        this.gpt.messages.push(choice.message);
        if (choice.message.content) text += choice.message.content;

        const toolCalls = (choice.message.tool_calls || []).map(({ id, function: fn }) => ({
          id, name: fn.name, input: this.parseArgs(fn.arguments),
        }));
        const mcpCalls = toolCalls.filter((c) => this.mcp.isMcpTool(c.name));
        clientCalls = toolCalls.filter((c) => !this.mcp.isMcpTool(c.name));

        if (!mcpCalls.length) break;
        // Execute the bridged calls in place and continue the SAME completion.
        // Any client calls in the same batch keep their tool messages pending —
        // callResult() supplies them before the next request (the provider only
        // requires every id answered before the following assistant turn).
        for (const call of mcpCalls) {
          const result = await this.mcp.call(call.name, call.input, callBack);
          this.gpt.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        if (clientCalls.length) break; // let the chat loop answer these first
      }
    } catch (e) {
      // Hops completed before the failure were still billed by the provider —
      // ride their usage on the error so the caller's error path can meter it.
      if (e && typeof e === 'object'
        && (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens || usage.cacheWriteTokens)) {
        e.usage = usage;
      }
      throw e;
    }

    const result = { text, calls: clientCalls, truncated, usage };
    callBack && callBack(result);
    return result;
  }

  parseArgs(raw) {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return { _raw: raw };
    }
  }

  async callResult(results, callBack) {
    results.forEach(({ id, result }) => this.gpt.messages.push({
      role: 'tool',
      tool_call_id: id,
      content: result,
    }));
    return this.rawCompletion(null, callBack);
  }

  /**
   * Called by the TURN OWNER when a turn aborted between a completion that
   * returned tool_calls and the callResult that would answer them: history
   * ends with dangling tool_call ids, and the provider 400s every subsequent
   * request until each id has a tool message. Synthesizes error results for
   * the unanswered ids. Never call speculatively — see gemini.js abandonTurn.
   */
  abandonTurn() {
    const messages = this.gpt?.messages || [];
    const answered = new Set(
      messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.length);
    const dangling = (lastAssistant?.tool_calls || []).filter((c) => !answered.has(c.id));
    if (!dangling.length) return;
    this.logger.warn({ calls: dangling.map((c) => c.function?.name) },
      `${this.constructor.name}: answering tool_calls abandoned by a failed turn`);
    dangling.forEach((c) => messages.push({
      role: 'tool',
      tool_call_id: c.id,
      content: 'ERROR: tool result unavailable (the turn was aborted before this tool could run)',
    }));
  }

  /** Release the bridge's standing MCP connections (owners call at session end). */
  async close() {
    await this.mcp?.close();
  }
}

export default OpenAiCompatible;
