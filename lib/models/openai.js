import OpenAI from 'openai';
import Llm from './llm.js';
const { OPENAI_API_KEY } = process.env;

// Safety cap on hosted-MCP continuation hops within one completion (the
// Responses API executes MCP tools server-side inside one request, so unlike
// Anthropic's pause_turn there is normally nothing to resume — this bounds
// the defensive retry loop only).
const DEFAULT_MAX_TOKENS = 4096;

// reasoning.effort acceptance by model family: the 5.5 generation has no
// 'max'; 'xhigh' arrived with 5.5. Anything unsupported is degraded rather
// than 400ing every turn (parity with the Anthropic driver's effort gate).
const EFFORT_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const NO_MAX_EFFORT = /^gpt-5\.5/;

/**
 * OpenAI driver on the RESPONSES API (`text:openai/...` agents). Rewritten
 * from the legacy axios chat-completions driver, which hardcoded
 * max_tokens=1024 (every builder save truncated), listed only 3.5/4-era
 * models, sent sampling params the 5.x reasoning models reject, and swallowed
 * errors into an apology string with the usage lost.
 *
 * - Statefulness: store:false + full input replay — response.output items
 *   (including reasoning items) are replayed verbatim; the API errors if
 *   reasoning/function_call items are dropped. Prompt caching is automatic on
 *   >=1024-token prefixes (usage.input_tokens_details.cached_tokens).
 * - Tools: flat Responses-API function tools; results returned as
 *   function_call_output items keyed by call_id.
 * - MCP: top-level `mcpServers` map to the HOSTED MCP tool (server-side
 *   execution, like the Anthropic connector) — `authorization` resolved from
 *   the agent's write-only keys; a server whose key can't resolve is dropped
 *   for the call rather than 424-failing the whole request.
 *
 * @class OpenAi
 * @extends {Llm}
 */
class OpenAi extends Llm {

  static allModels = [
    ['gpt-5.6-sol', 'OpenAI GPT-5.6 Sol'],
    ['gpt-5.6-terra', 'OpenAI GPT-5.6 Terra'],
    ['gpt-5.6-luna', 'OpenAI GPT-5.6 Luna'],
    ['gpt-5.5', 'OpenAI GPT-5.5'],
    ['gpt-4o', 'OpenAI GPT-4o'],
  ].map(([name, description]) => ([`${this.name.toLowerCase()}/${name}`, description]));

  static get needKey() {
    return { OPENAI_API_KEY };
  }

  static supportsFunctions = () => true;
  // Hosted MCP tool — server-side execution, like the Anthropic connector.
  static supportsMcp = () => true;
  static provider = 'openai';

  constructor({ logger, prompt, options, model, modelName, mcpServers, keys }) {
    super(...arguments);
    this.client = new OpenAI({
      apiKey: OPENAI_API_KEY,
      maxRetries: 1,
      timeout: Number(process.env.OPENAI_TIMEOUT_MS || 900000),
    });
    this.mcpServers = Array.isArray(mcpServers) ? mcpServers : [];
    // Handler-constructed (voice) sessions spread agent.dataValues, which has
    // only modelName — without this fallback they'd silently run the catalogue
    // default instead of the agent's configured model.
    this.model = model || modelName || OpenAi.allModels[0][0];
    this.maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS;
    this.effort = OpenAi.effortFor(this.gpt.model, options?.effort, this.logger);
    this.gpt = { ...(this.gpt || {}), input: [] };
    logger.debug({ model: this.gpt.model, mcpServers: this.mcpServers.length }, 'NEW OpenAi (responses) agent');
  }

  /** The effort value safe to send for this model, or undefined to omit. */
  static effortFor(model, requested, logger) {
    if (!requested) return undefined;
    if (!EFFORT_LEVELS.has(requested)) {
      logger.warn({ effort: requested }, 'ignoring unknown options.effort value');
      return undefined;
    }
    if (requested === 'max' && NO_MAX_EFFORT.test(model)) return 'xhigh';
    if (/^gpt-4/.test(model)) return undefined; // pre-reasoning models
    return requested;
  }

  set prompt(newPrompt) {
    this._prompt = newPrompt; // sent per-request as `instructions`
  }
  get prompt() { return this._prompt; }

  set functions(functions) {
    this._functions = functions;
    // Responses API function tools are FLAT (no nested `function` wrapper).
    this.tools = (functions || []).map(({ name, description, input_schema }) => ({
      type: 'function', name, description, parameters: input_schema,
    }));
  }
  get functions() { return this._functions; }

  set options(newOptions) { this._options = newOptions; }
  get options() { return this._options; }

  /** Bearer for one MCP server (explicit token, else write-only keys entry). */
  serverAuthToken(server) {
    if (server.authorization_token) return server.authorization_token;
    if (!server.key) return undefined;
    const key = (this.keys || []).find((k) => k.name === server.key);
    if (key?.in === 'bearer') return key.value;
    return null; // unresolvable — caller drops the server
  }

  /** Function tools plus one hosted-MCP tool per usable server. */
  toolsParam() {
    const tools = [...(this.tools || [])];
    for (const server of this.mcpServers) {
      const token = this.serverAuthToken(server);
      if (token === null) {
        this.logger.warn({ server: server.name, key: server.key },
          'mcpServers key reference unresolved — dropping server for this call');
        continue;
      }
      tools.push({
        type: 'mcp',
        server_label: String(server.name).replace(/[^a-zA-Z0-9_-]/g, '_'),
        server_url: server.url,
        ...(token ? { authorization: token } : {}),
        require_approval: 'never',
      });
    }
    return tools;
  }

  async initial(callBack) {
    return this.rawCompletion('hello', callBack);
  }

  async rawCompletion(input, callBack) {
    if (input) this.gpt.input.push({ role: 'user', content: input });
    const tools = this.toolsParam();
    // STREAMED so a client tool call's NAME surfaces the moment its
    // function_call item is added — a builder set-save generates arguments for
    // tens of seconds, and the UI needs "the team is being changed" at the
    // start of that window, not the end (`callBack({ tool_use_start })`). The
    // SDK stream helper accumulates the identical final response — lifecycle
    // events carry the server's own final object, so the stateless replay of
    // output items (encrypted reasoning included) and usage are unchanged.
    const stream = this.client.responses.stream({
      model: this.gpt.model,
      instructions: this._prompt,
      input: this.gpt.input,
      max_output_tokens: this.maxTokens,
      store: false,
      // With store:false the server keeps nothing, so replayed reasoning
      // items must carry their content INLINE — without this, replaying an
      // rs_ item 404s ("Items are not persisted when store is set to false").
      include: ['reasoning.encrypted_content'],
      ...(this.effort ? { reasoning: { effort: this.effort } } : {}),
      ...(tools.length ? { tools } : {}),
    });
    // Streaming moves the client timeout to time-to-first-byte only; keep a
    // stall guarantee by aborting after OPENAI_TIMEOUT_MS with no stream
    // event (finalResponse() then rejects and the turn errors visibly).
    const stallMs = Number(process.env.OPENAI_TIMEOUT_MS || 900000);
    let stallTimer = setTimeout(() => stream.abort(), stallMs);
    stream.on('event', (event) => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stream.abort(), stallMs);
      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call' && event.item.name) {
        this.logger.info({ tool: event.item.name }, 'openai function_call item started');
        callBack && callBack({ tool_use_start: { name: event.item.name } });
      } else if (event.type === 'response.output_item.added' && event.item?.type === 'mcp_call' && event.item.name) {
        // Hosted MCP runs server-side inside the response; a start line is the
        // only signal we get while a slow/stalled MCP server is holding the turn.
        this.logger.info({ tool: event.item.name, server: event.item.server_label }, 'openai hosted MCP call started');
      }
    });
    let response;
    try {
      response = await stream.finalResponse();
    } finally {
      clearTimeout(stallTimer);
    }

    // Replay EVERYTHING (reasoning items included) — the API errors if
    // reasoning/function_call items are missing on a stateless follow-up.
    // The stream helper's finalResponse() runs the SDK parse pass, which
    // ANNOTATES items with parse artifacts (function_call.parsed_arguments,
    // output_text content .parsed) that are not valid REQUEST fields — strip
    // them or the replay 400s ("Unknown parameter: 'input[N].parsed_arguments'").
    this.gpt.input.push(...(response.output || []).map(OpenAi.stripParseArtifacts));

    let text = '';
    const calls = [];
    for (const item of response.output || []) {
      if (item.type === 'message') {
        text += (item.content || [])
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text)
          .join('');
      } else if (item.type === 'function_call') {
        calls.push({ id: item.call_id, name: item.name, input: this.parseArgs(item.arguments) });
      } else if (item.type === 'mcp_call') {
        // Completion outcome, WARN on failure — without status/outputBytes here
        // a dead MCP round is invisible server-side and gets misdiagnosed from
        // ingress logs (or worse, taken on the model's word).
        const failed = !!item.error;
        this.logger[failed ? 'warn' : 'info']({
          tool: item.name,
          server: item.server_label,
          status: failed ? 'error' : 'ok',
          outputBytes: typeof item.output === 'string' ? item.output.length : 0,
          error: item.error || undefined,
        }, 'openai hosted MCP call');
        callBack && callBack({ mcp_tool_use: { name: item.name, server: item.server_label } });
      } else if (item.type === 'mcp_list_tools') {
        // Discovery result per server — a server silently dropped from the
        // toolset (the key-desync class) shows up here as a missing line or
        // an error, instead of needing a fleet-wide log reconstruction.
        this.logger.info({
          server: item.server_label,
          tools: Array.isArray(item.tools) ? item.tools.length : 0,
          error: item.error || undefined,
        }, 'openai hosted MCP tools listed');
      }
    }

    const u = response.usage;
    const result = {
      text,
      calls,
      truncated: response.status === 'incomplete'
        && response.incomplete_details?.reason === 'max_output_tokens',
      usage: {
        provider: OpenAi.provider,
        model: this.model,
        // input_tokens INCLUDES the cached portion — report the uncached
        // remainder as inputTokens so the ledger units stay disjoint (the
        // same split the Anthropic driver reports).
        inputTokens: Math.max(0, (u?.input_tokens || 0) - (u?.input_tokens_details?.cached_tokens || 0)),
        outputTokens: u?.output_tokens || 0,
        cacheReadTokens: u?.input_tokens_details?.cached_tokens || 0,
        cacheWriteTokens: 0,
      },
    };
    // Per-request cache observability, symmetric with the compat/gemini hop
    // logs — uncached input on a long session flags a broken prefix cache.
    this.logger.info(
      { model: this.model, in: result.usage.inputTokens, cached: result.usage.cacheReadTokens, out: result.usage.outputTokens },
      'openai completion usage');
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

  /**
   * Drop the parse-pass annotations the stream helper's finalResponse() adds
   * to output items (`parsed_arguments` on function/custom tool calls,
   * `parsed` on output_text content parts). They are response-side sugar the
   * Responses API rejects as unknown parameters when the item is replayed as
   * INPUT on the next stateless request.
   */
  static stripParseArtifacts(item) {
    if (!item || typeof item !== 'object') return item;
    const { parsed_arguments, ...rest } = item;
    if (Array.isArray(rest.content)) {
      rest.content = rest.content.map((c) => {
        if (c && typeof c === 'object' && 'parsed' in c) {
          const { parsed, ...part } = c;
          return part;
        }
        return c;
      });
    }
    return rest;
  }

  async callResult(results, callBack) {
    results.forEach(({ id, result }) => this.gpt.input.push({
      type: 'function_call_output',
      call_id: id,
      // A missing/undefined result would serialise WITHOUT the `output` field,
      // and the Responses API then rejects the replayed history on EVERY later
      // request ("Missing required parameter: 'input[N].output'") — bricking
      // the session. Coerce, never drop.
      output: typeof result === 'string'
        ? result
        : (result === undefined || result === null
          ? 'ERROR: tool returned no result'
          : JSON.stringify(result)),
    }));
    return this.rawCompletion(null, callBack);
  }

  /**
   * Called by the TURN OWNER when a turn aborted between a completion that
   * returned function_call items and the callResult that would answer them:
   * the Responses API rejects the replayed input until every function_call
   * has a function_call_output. Synthesizes error outputs for the unanswered
   * call ids. Never call speculatively — see gemini.js abandonTurn.
   */
  abandonTurn() {
    const input = this.gpt?.input || [];
    // Repair output items that LOOK answered but would serialise invalid (an
    // undefined/null output field is dropped by JSON and 400s every replay).
    input.forEach((item) => {
      if (item.type === 'function_call_output' && (item.output === undefined || item.output === null)) {
        this.logger.warn({ call_id: item.call_id }, 'openai: repairing empty function_call_output');
        item.output = 'ERROR: tool returned no result';
      }
    });
    const answered = new Set(
      input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id));
    const dangling = input.filter((item) => item.type === 'function_call' && !answered.has(item.call_id));
    if (!dangling.length) return;
    this.logger.warn({ calls: dangling.map((c) => c.name) },
      'openai: answering function_calls abandoned by a failed turn');
    dangling.forEach((c) => input.push({
      type: 'function_call_output',
      call_id: c.call_id,
      output: 'ERROR: tool result unavailable (the turn was aborted before this tool could run)',
    }));
  }
}

export default OpenAi;
