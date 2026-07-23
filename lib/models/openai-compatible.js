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
      // With streaming (streamOnce) the SDK timeout bounds TIME-TO-FIRST-BYTE
      // only; the same value is re-applied as an inter-chunk inactivity window
      // inside streamOnce, so a provider hang (Moonshot has been observed to
      // hang on large contexts) aborts within the bound at any stage while a
      // long legitimate generation streams on untouched.
      timeout: Number(process.env.OPENAI_COMPAT_TIMEOUT_MS || 300000),
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
    // it under prompt_tokens_details (OpenRouter adds cache_write_tokens);
    // DeepSeek reports prompt_cache_hit_tokens — without reading it, DeepSeek
    // cache hits were ledgered as full-price input and invisible to
    // diagnostics.
    const cacheReadTokens = u?.prompt_tokens_details?.cached_tokens
      ?? u?.cached_tokens
      ?? u?.prompt_cache_hit_tokens
      ?? 0;
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
        const { message, finishReason, usage: rawUsage } = await this.streamOnce(tools, callBack);
        const u = this.usageOf(rawUsage);
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
        usage.cacheReadTokens += u.cacheReadTokens;
        usage.cacheWriteTokens += u.cacheWriteTokens;
        // Per-hop cache observability: uncached input on a long-running
        // session means the provider's automatic prefix cache is NOT engaging
        // — the dominant latency term for big-context sessions. Keep at info.
        this.logger.info(
          { hop, model: this.model, in: u.inputTokens, cached: u.cacheReadTokens, out: u.outputTokens },
          'compat completion hop');
        truncated = finishReason === 'length';
        // Push the assistant message WHOLE — reasoning_content (Moonshot,
        // DeepSeek) / reasoning_details (OpenRouter) must ride the history in
        // tool loops.
        this.gpt.messages.push(message);
        if (message.content) text += message.content;

        const toolCalls = (message.tool_calls || []).map(({ id, function: fn }) => ({
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

  /**
   * One STREAMED chat completion, manually accumulated back into a whole
   * assistant message. Streamed (not create()) for two reasons: a client tool
   * call's NAME surfaces the moment its first delta arrives — the UI needs
   * "the team is being changed" at the START of a long argument generation
   * (`callBack({ tool_use_start })`, parity with the openai/anthropic
   * drivers) — and the request bound becomes time-to-first-byte + an
   * INTER-CHUNK inactivity window instead of a whole-request ceiling, so a
   * provider hang aborts fast while a long legitimate generation streams on.
   *
   * Accumulation is MANUAL (not the SDK's stream helper) because these
   * providers extend the delta shape with fields the helper would drop —
   * reasoning_content (Moonshot, DeepSeek) and reasoning_details (OpenRouter)
   * — which MUST be reassembled onto the history message for tool-loop
   * replay. Usage arrives in a final empty-choices chunk via
   * stream_options.include_usage.
   */
  async streamOnce(tools, callBack) {
    const stream = await this.client.chat.completions.create({
      ...this.requestBody(tools),
      stream: true,
      stream_options: { include_usage: true },
    });
    const stallMs = Number(process.env.OPENAI_COMPAT_TIMEOUT_MS || 300000);
    let stallTimer;
    let stalled = false;
    const arm = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { stalled = true; stream.controller.abort(); }, stallMs);
    };
    arm();

    const message = { role: 'assistant', content: null };
    const toolCalls = [];
    const announced = new Set();
    let finishReason = null;
    let usage = null;
    try {
      for await (const chunk of stream) {
        arm();
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const d = choice.delta || {};
        if (d.content) message.content = (message.content || '') + d.content;
        if (d.reasoning_content) {
          message.reasoning_content = (message.reasoning_content || '') + d.reasoning_content;
        }
        if (Array.isArray(d.reasoning_details)) {
          // OpenRouter streams typed entries, each tagged with its index —
          // merge text fragments per index so the replayed array matches the
          // non-streamed shape; entries without an index are appended whole.
          message.reasoning_details = message.reasoning_details || [];
          for (const entry of d.reasoning_details) {
            const at = Number.isInteger(entry?.index) ? entry.index : message.reasoning_details.length;
            const cur = message.reasoning_details[at];
            message.reasoning_details[at] = cur
              ? { ...cur, ...entry, ...(entry.text ? { text: (cur.text || '') + entry.text } : {}) }
              : { ...entry };
          }
        }
        for (const tc of d.tool_calls || []) {
          const i = Number.isInteger(tc.index) ? tc.index : 0;
          toolCalls[i] = toolCalls[i] || { id: undefined, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          const name = toolCalls[i].function.name;
          if (name && !announced.has(i)) {
            announced.add(i);
            this.logger.info({ tool: name }, 'compat tool_call started');
            callBack && callBack({ tool_use_start: { name } });
          }
        }
      }
    } catch (e) {
      clearTimeout(stallTimer);
      if (stalled) {
        throw new Error(`${this.constructor.name}: stream stalled (no data for ${stallMs}ms)`);
      }
      throw e;
    } finally {
      clearTimeout(stallTimer);
    }
    if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
    return { message, finishReason, usage };
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
      // Same hazard as openai.js: an undefined result serialises without
      // `content` and the provider rejects the whole history on every later
      // request. Coerce, never drop.
      content: typeof result === 'string'
        ? result
        : (result === undefined || result === null
          ? 'ERROR: tool returned no result'
          : JSON.stringify(result)),
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
