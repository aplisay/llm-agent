import Llm from './llm.js';
import { Anthropic as AnthropicSdk } from '@anthropic-ai/sdk';
const { ANTHROPIC_API_KEY } = process.env;

// Bound every Messages API call. The SDK default timeout is 10 minutes, so a
// stalled MCP-connector round trip would hang a chat turn silently (no error,
// spinner stuck) for that long. With this, a stall surfaces as a fast, visible
// error instead. Retries kept low so a timeout doesn't compound. Both env-tunable.
// Since the move to streaming (create() below), the SDK timeout only bounds
// time-to-first-byte — the same value is therefore also applied as an
// INACTIVITY window between stream events, preserving the original guarantee
// (a mid-generation stall aborts within the bound instead of hanging forever).
const REQUEST_TIMEOUT_MS = Number(process.env.ANTHROPIC_REQUEST_TIMEOUT_MS || 900000);
const MAX_RETRIES = Number(process.env.ANTHROPIC_MAX_RETRIES ?? 1);

const anthropic = new AnthropicSdk({ timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });

// Beta header for the Messages API MCP connector (remote MCP servers executed
// server-side). See platform docs: agents-and-tools/mcp-connector.
const MCP_BETA = 'mcp-client-2025-11-20';
// Safety cap on server-side (pause_turn) continuations within one completion.
const MAX_SERVER_HOPS = 6;
const DEFAULT_MAX_TOKENS = 4096;

// TTL for the prompt-cache breakpoints of INTERACTIVE sessions. Chats are
// human-paced — a think-pause or an in-browser test call routinely outlives
// the default 5-minute TTL, and every lapse re-WRITES the whole accumulated
// prefix at the write premium instead of re-reading it at 0.1x (staging
// showed 2-4 lapses per builder session). The 1-hour TTL doubles the write
// premium (2x vs 1.25x base input) but keeps the prefix warm across pauses —
// net cheaper on any session with a pause. Headless one-shot paths (invoke,
// subagent) never pause, so they stay on the default 5m (see the constructor's
// `interactive` flag). Env-tunable for A/B via the metered cacheWriteTokens:
// set ANTHROPIC_CACHE_TTL=5m to revert. The API accepts exactly '5m' | '1h' —
// anything else would 400 EVERY request process-wide, so validate.
const CACHE_TTL_RAW = process.env.ANTHROPIC_CACHE_TTL;
const CACHE_TTL = ['5m', '1h'].includes(CACHE_TTL_RAW) ? CACHE_TTL_RAW : '1h';
if (CACHE_TTL_RAW && CACHE_TTL_RAW !== CACHE_TTL) {
  console.warn(`ANTHROPIC_CACHE_TTL="${CACHE_TTL_RAW}" is not a valid cache TTL ('5m'|'1h') — using '1h'`);
}
const INTERACTIVE_CACHE_CONTROL = CACHE_TTL === '5m'
  ? { type: 'ephemeral' }
  : { type: 'ephemeral', ttl: CACHE_TTL };
const DEFAULT_CACHE_CONTROL = { type: 'ephemeral' };

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

  // Values the GA `output_config.effort` parameter accepts. Anything else in
  // options.effort is ignored (with a warning) rather than 400ing every turn.
  static EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  // Effort support varies BY MODEL among the models we offer: these two reject
  // output_config.effort outright, and 'xhigh' only exists from Opus 4.7 —
  // sending an unsupported combo 400s every turn, so gate per model too.
  static EFFORT_UNSUPPORTED = new Set(['claude-sonnet-4-5', 'claude-haiku-4-5']);
  static EFFORT_NO_XHIGH = new Set(['claude-opus-4-6', 'claude-sonnet-4-6']);

  /** The effort value safe to send for this model, or undefined to omit. */
  static effortFor(model, requested, logger) {
    if (!requested) return undefined;
    if (!Anthropic.EFFORT_LEVELS.has(requested)) {
      logger.warn({ effort: requested }, 'ignoring unknown options.effort value');
      return undefined;
    }
    const bare = String(model).split('/').pop();
    if (Anthropic.EFFORT_UNSUPPORTED.has(bare)) {
      logger.warn({ model, effort: requested }, 'model rejects output_config.effort — ignoring');
      return undefined;
    }
    if (requested === 'xhigh' && Anthropic.EFFORT_NO_XHIGH.has(bare)) {
      logger.warn({ model, effort: requested }, "model has no 'xhigh' effort — using 'high'");
      return 'high';
    }
    return requested;
  }

  constructor({ logger, prompt, options, model, modelName, mcpServers, interactive }) {
    super(...arguments);
    // The module-level SDK instance, referenced per-instance so tests can
    // inject a fake client (parity with the openai driver's this.client).
    this.client = anthropic;
    this.mcpServers = Array.isArray(mcpServers) ? mcpServers : [];
    // Handler-constructed (voice) sessions spread agent.dataValues, which has
    // only modelName — without this fallback they'd silently run the catalogue
    // default instead of the agent's configured model.
    this.model = model || modelName || Anthropic.allModels[0][0];
    // Interactive (human-paced chat) sessions use the long cache TTL; headless
    // one-shots (invoke/subagent) never pause, so the doubled 1h write premium
    // would be a pure cost increase there — they keep the 5m default.
    this.cacheControl = interactive ? INTERACTIVE_CACHE_CONTROL : DEFAULT_CACHE_CONTROL;
    // Optional reasoning-effort hint (options.effort): current models default
    // to effort 'high'. Note this driver never sends a `thinking` param, so
    // whether thinking runs is per-model default behaviour — implicit adaptive
    // on Sonnet 5 (and always-on on Fable), OFF-when-omitted on Opus 4.7/4.8 —
    // and effort here mainly bounds output verbosity (plus thinking depth
    // where thinking runs). Only sent when set AND supported by the model.
    this.effort = Anthropic.effortFor(this.model, options?.effort, logger);
    this.gpt = {
      ...(this.gpt || {}),
      // Note: temperature/top_p are intentionally omitted — current Claude
      // models (Opus 4.x etc.) reject them.
      max_tokens: options?.maxTokens || DEFAULT_MAX_TOKENS,
      system: prompt,
      messages: [],
    };
    logger.debug({ prompt, model: this.gpt.model, effort: this.effort, mcpServers: this.mcpServers.length }, 'NEW Anthropic agent');
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

  // Content-block types a prompt-cache breakpoint (`cache_control`) may attach
  // to. mcp_tool_use / mcp_tool_result (connector blocks) are deliberately
  // excluded — a breakpoint earlier in the message still caches the prefix.
  static CACHEABLE_BLOCKS = new Set(['text', 'tool_result', 'tool_use', 'image', 'document']);

  /**
   * Return a COPY of the messages array with a single `cache_control` breakpoint
   * on the most recent cacheable block. Anthropic caches the whole prefix up to
   * a breakpoint, so this makes each round re-read the (large, ever-growing)
   * conversation — MCP doc-reads especially — at ~0.1x instead of re-billing it
   * in full every turn. Applied to a copy so the stored history stays clean and
   * we never accrue past the 4-breakpoint limit.
   *
   * Walks BACK from the last message: a pause_turn continuation can end on a
   * message that is entirely connector (mcp_tool_use/mcp_tool_result) or
   * thinking blocks, and a breakpoint may only attach to a cacheable type —
   * skipping the breakpoint there (the old behaviour) billed the whole
   * conversation uncached for that call. (Residual caveat: a breakpoint finds
   * its prior cache entry within a 20-content-block lookback, so a single hop
   * adding more than ~20 blocks can still miss — rare enough to accept.)
   */
  /**
   * A stream that dies mid-connector-round (MCP server flap, network cut) can
   * persist an assistant message whose content carries an `mcp_tool_use` with
   * no paired `mcp_tool_result` — and the Messages API then rejects the whole
   * replayed history on EVERY later request, bricking the session. Strip any
   * unpaired connector blocks (either direction) before building a request;
   * drop a message entirely if that leaves its content empty.
   */
  healOrphanMcpBlocks() {
    const messages = this.gpt?.messages || [];
    const uses = new Set();
    const results = new Set();
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b?.type === 'mcp_tool_use') uses.add(b.id);
        else if (b?.type === 'mcp_tool_result') results.add(b.tool_use_id);
      }
    }
    const orphanUses = [...uses].filter((id) => !results.has(id));
    const orphanResults = [...results].filter((id) => !uses.has(id));
    if (!orphanUses.length && !orphanResults.length) return;
    this.logger.warn({ orphanUses, orphanResults },
      'anthropic: stripping unpaired mcp_tool_use/mcp_tool_result blocks from history');
    this.gpt.messages = messages
      .map((m) => {
        if (!Array.isArray(m.content)) return m;
        const content = m.content.filter((b) => !(
          (b?.type === 'mcp_tool_use' && orphanUses.includes(b.id))
          || (b?.type === 'mcp_tool_result' && orphanResults.includes(b.tool_use_id))
        ));
        return content.length ? { ...m, content } : null;
      })
      .filter(Boolean);
  }

  withMessageCacheBreakpoint(messages) {
    const copy = messages.slice();
    for (let m = copy.length - 1; m >= 0; m -= 1) {
      const msg = copy[m];
      const blocks = typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : Array.isArray(msg.content) ? msg.content.map((b) => ({ ...b })) : null;
      if (!blocks) continue;
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        if (Anthropic.CACHEABLE_BLOCKS.has(blocks[i].type)) {
          blocks[i] = { ...blocks[i], cache_control: this.cacheControl };
          copy[m] = { ...msg, content: blocks };
          return copy;
        }
      }
    }
    return messages;
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

  /**
   * One Messages API call against the current conversation; MCP connector when
   * configured. STREAMED so a client tool call's NAME surfaces the moment its
   * tool_use block starts — a builder set-save generates arguments for tens of
   * seconds, and the UI needs "the team is being changed" at the start of that
   * window, not the end (`callBack({ tool_use_start })`). The SDK stream helper
   * accumulates the identical final message (`finalMessage()`), so the
   * completion contract, history replay and usage accounting are unchanged.
   */
  async create(callBack) {
    const mcpServers = this.activeMcpServers();
    const tools = this.toolsParam(mcpServers);
    // Send the (static, re-sent every round) system prompt as a content block
    //  with a cache_control breakpoint so successive rounds of the same
    //  conversation hit the prompt cache rather than re-billing it in full.
    const system = this.gpt.system
      ? [{ type: 'text', text: this.gpt.system, cache_control: this.cacheControl }]
      : undefined;
    // Two cache breakpoints (well under Anthropic's limit of 4): the static
    //  system prompt, and a rolling one on the last message so system + tools +
    //  the entire accumulated conversation are re-read from cache each round.
    this.healOrphanMcpBlocks();
    const messages = this.withMessageCacheBreakpoint(this.gpt.messages);
    const request = {
      model: this.gpt.model,
      max_tokens: this.gpt.max_tokens,
      ...(this.effort ? { output_config: { effort: this.effort } } : {}),
      ...(system ? { system } : {}),
      messages,
      ...(tools.length ? { tools } : {}),
    };
    const stream = mcpServers.length
      ? this.client.beta.messages.stream({
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
      })
      : this.client.messages.stream(request);
    // Streaming moves the SDK timeout to time-to-first-byte only; keep the
    // original stall guarantee by aborting after REQUEST_TIMEOUT_MS with no
    // stream event (finalMessage() then rejects and the turn errors visibly).
    let stallTimer = setTimeout(() => stream.abort(), REQUEST_TIMEOUT_MS);
    stream.on('streamEvent', (event) => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stream.abort(), REQUEST_TIMEOUT_MS);
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        this.logger.info({ tool: event.content_block.name }, 'anthropic tool_use block started');
        callBack && callBack({ tool_use_start: { name: event.content_block.name } });
      }
    });
    try {
      return await stream.finalMessage();
    } finally {
      clearTimeout(stallTimer);
    }
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
    try {
      for (let hop = 0; hop < MAX_SERVER_HOPS; hop += 1) {
        const message = await this.create(callBack);
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
    } catch (e) {
      // Hops completed before the failure were still billed by the provider —
      // ride their usage on the error so the caller's error path can meter it.
      if (e && typeof e === 'object'
        && (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens || usage.cacheWriteTokens)) {
        e.usage = usage;
      }
      throw e;
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

  /**
   * Called by the TURN OWNER when a turn aborted between a completion that
   * returned tool_use blocks and the callResult that would answer them: the
   * API rejects every subsequent request until each tool_use has a
   * tool_result. Synthesizes error results for the unanswered ids. Never call
   * speculatively — see gemini.js abandonTurn.
   */
  abandonTurn() {
    const messages = this.gpt?.messages || [];
    const answered = new Set(
      messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id));
    const lastAssistant = [...messages].reverse()
      .find((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));
    const dangling = (lastAssistant?.content || [])
      .filter((b) => b.type === 'tool_use' && !answered.has(b.id));
    if (!dangling.length) return;
    this.logger.warn({ calls: dangling.map((b) => b.name) },
      'anthropic: answering tool_use blocks abandoned by a failed turn');
    this.gpt.messages.push({
      role: 'user',
      content: dangling.map((b) => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: 'ERROR: tool result unavailable (the turn was aborted before this tool could run)',
        is_error: true,
      })),
    });
  }
}

export default Anthropic;
