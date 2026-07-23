import { GoogleGenAI } from '@google/genai';
import Llm from './llm.js';
import McpToolBridge from './mcp-tools.js';
const { GOOGLE_API_KEY } = process.env;

const DEFAULT_MAX_TOKENS = 4096;
// Cap on internal MCP round-trips within one completion (parity with the
// other drivers' bridge/connector hop limits).
const MAX_MCP_HOPS = 6;

/**
 * Google Gemini via the current @google/genai SDK (API-key mode), replacing
 * the retired Vertex-preview driver (lib/models/google-vertexai.js) whose
 * tool-schema transform kept only top-level {type, description} per property
 * — nested schemas like create_agent_set's agents[] arrived as an empty
 * shell — and which sent the system prompt as a fake first user message,
 * hardcoded maxOutputTokens=2048, and listed retired 1.5-preview models.
 *
 * - Full-fidelity tools: functionDeclarations use `parametersJsonSchema`
 *   (raw JSON Schema pass-through — nested objects/arrays/enums intact).
 * - Own history via models.generateContent: model content parts are echoed
 *   back VERBATIM (Gemini 3 thought signatures ride the parts and replaying
 *   them is mandatory when self-managing history).
 * - `options.maxTokens` honoured; usage from usageMetadata (thought tokens
 *   are billed as output, so they are included in outputTokens).
 * - Top-level `mcpServers` honoured via the client-side MCP bridge.
 *
 * @class Gemini
 * @extends {Llm}
 */
class Gemini extends Llm {

  static allModels = [
    ['gemini-3.5-flash', 'Google Gemini 3.5 Flash'],
    ['gemini-3.1-pro-preview', 'Google Gemini 3.1 Pro (preview)'],
    ['gemini-3-flash-preview', 'Google Gemini 3 Flash (preview)'],
    ['gemini-3.1-flash-lite', 'Google Gemini 3.1 Flash Lite'],
    ['gemini-2.5-pro', 'Google Gemini 2.5 Pro'],
    ['gemini-2.5-flash', 'Google Gemini 2.5 Flash'],
  ].map(([name, description]) => ([`${this.name.toLowerCase()}/${name}`, description]));

  static get needKey() {
    return { GOOGLE_API_KEY };
  }

  static supportsFunctions = () => true;
  // MCP via the client-side bridge.
  static supportsMcp = () => true;
  static provider = 'google';

  constructor({ logger, prompt, options, model, modelName, mcpServers, keys }) {
    super(...arguments);
    this.ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
    // Handler-constructed (voice) sessions spread agent.dataValues, which has
    // only modelName — without this fallback they'd silently run the catalogue
    // default instead of the agent's configured model.
    this.model = model || modelName || Gemini.allModels[0][0];
    this.maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS;
    this.temperature = options?.temperature;
    this.mcp = new McpToolBridge({ mcpServers, keys, logger: this.logger });
    this.contents = [];
    logger.debug({ model: this.gpt.model }, 'NEW Gemini agent');
  }

  set prompt(newPrompt) {
    this._prompt = newPrompt; // sent per-request as config.systemInstruction
  }
  get prompt() { return this._prompt; }

  set functions(functions) {
    this._functions = functions;
    this.declarations = (functions || []).map(({ name, description, input_schema }) => ({
      name,
      description,
      // Raw JSON Schema pass-through — mutually exclusive with `parameters`.
      parametersJsonSchema: input_schema,
    }));
  }
  get functions() { return this._functions; }

  set options(newOptions) { this._options = newOptions; }
  get options() { return this._options; }

  async initial(callBack) {
    return this.rawCompletion('hello', callBack);
  }

  async toolsParam() {
    const bridged = await this.mcp.ensure();
    const declarations = [
      ...(this.declarations || []),
      ...bridged.map(({ name, description, input_schema }) => ({
        name, description, parametersJsonSchema: input_schema,
      })),
    ];
    return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
  }

  /**
   * Called by the TURN OWNER (text-chat's error path) when a turn aborted
   * between the model's functionCalls and their results (a tool handler threw
   * and the chat loop dropped the turn): history ends with unanswered calls —
   * Gemini rejects every subsequent request until they are answered, wedging
   * the session. Synthesizes error responses for the dangling calls (merging
   * any bridged-MCP results held in pendingParts) so the next turn is valid.
   * NEVER call this speculatively (e.g. at rawCompletion entry): on the
   * unserialised voice path a dangling call may be legitimately in flight,
   * and pre-answering it corrupts history and invites double tool execution.
   */
  abandonTurn() {
    const held = this.pendingParts || [];
    this.pendingParts = null;
    const last = this.contents[this.contents.length - 1];
    if (last?.role !== 'model') return;
    const calls = (last.parts || []).filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) return;
    this.logger.warn({ calls: calls.map((c) => c.name) },
      'gemini: answering functionCalls abandoned by a failed turn');
    const parts = calls.map((call) => {
      const i = held.findIndex((h) => h.functionResponse?.name === call.name);
      if (i >= 0) return held.splice(i, 1)[0];
      return {
        functionResponse: {
          name: call.name,
          ...(call.id ? { id: call.id } : {}),
          response: { result: 'ERROR: tool result unavailable (the turn was aborted before this tool could run)' },
        },
      };
    });
    this.contents.push({ role: 'user', parts });
  }

  async rawCompletion(input, callBack) {
    if (input) this.contents.push({ role: 'user', parts: [{ text: input }] });
    const tools = await this.toolsParam();
    const usage = {
      provider: Gemini.provider, model: this.model,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    };
    let text = '';
    let truncated = false;
    let clientCalls = [];

    try {
      for (let hop = 0; hop < MAX_MCP_HOPS; hop += 1) {
        const response = await this.ai.models.generateContent({
          model: this.gpt.model,
          contents: this.contents,
          config: {
            systemInstruction: this._prompt,
            maxOutputTokens: this.maxTokens,
            ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
            ...(tools ? { tools } : {}),
          },
        });
        const candidate = response.candidates?.[0];
        if (!candidate) throw new Error('Gemini: empty response');
        const u = response.usageMetadata;
        const cached = u?.cachedContentTokenCount || 0;
        usage.inputTokens += Math.max(0, (u?.promptTokenCount || 0) - cached);
        usage.cacheReadTokens += cached;
        // Thought tokens are billed as output.
        usage.outputTokens += (u?.candidatesTokenCount || 0) + (u?.thoughtsTokenCount || 0);
        // Per-hop cache observability (the July bake-off measured ~96k uncached
        // input per scenario on this driver — implicit caching not engaging;
        // this line is how we find out whether that is still true and when).
        this.logger.info(
          { model: this.model, in: Math.max(0, (u?.promptTokenCount || 0) - cached), cached, out: u?.candidatesTokenCount || 0 },
          'gemini completion hop');
        truncated = candidate.finishReason === 'MAX_TOKENS';
        // Echo the model content VERBATIM — Gemini 3 thought signatures ride
        // the parts and must be replayed when self-managing history.
        if (candidate.content) this.contents.push(candidate.content);
        text += (candidate.content?.parts || [])
          .filter((p) => p.text && !p.thought)
          .map((p) => p.text)
          .join('');

        const toolCalls = (response.functionCalls || []).map((fc) => ({
          id: fc.id, name: fc.name, input: fc.args || {},
        }));
        const mcpCalls = toolCalls.filter((c) => this.mcp.isMcpTool(c.name));
        clientCalls = toolCalls.filter((c) => !this.mcp.isMcpTool(c.name));

        if (!mcpCalls.length) break;
        const parts = [];
        for (const call of mcpCalls) {
          const result = await this.mcp.call(call.name, call.input, callBack);
          parts.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: { result } } });
        }
        if (clientCalls.length) {
          // Mixed batch: hold the bridged results — Gemini expects ALL of a
          // turn's functionResponses together, so they join the client results
          // in callResult().
          this.pendingParts = parts;
          break;
        }
        this.contents.push({ role: 'user', parts });
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

  async callResult(results, callBack) {
    // functionResponse wants the function NAME. The tool loop supplies it on
    // every result (including pause/truncation resumes); this fallback is
    // defensive only. Gemini often omits functionCall ids, so with id
    // undefined the only safe recovery is positional — the last model turn's
    // functionCall parts in order — and it must never match text/thought
    // parts (p.functionCall?.id === undefined is true for those).
    const nameOf = (id, index) => {
      for (let i = this.contents.length - 1; i >= 0; i -= 1) {
        const calls = (this.contents[i].parts || [])
          .filter((p) => p.functionCall).map((p) => p.functionCall);
        if (!calls.length) continue;
        return (id ? calls.find((c) => c.id === id) : calls[index])?.name;
      }
      return undefined;
    };
    const parts = results.map(({ id, name, result }, index) => ({
      functionResponse: { name: name || nameOf(id, index), ...(id ? { id } : {}), response: { result } },
    }));
    // Any bridged-MCP results held from a mixed batch join the same turn.
    if (this.pendingParts) {
      parts.push(...this.pendingParts);
      this.pendingParts = null;
    }
    this.contents.push({ role: 'user', parts });
    return this.rawCompletion(null, callBack);
  }

  /** Release the bridge's standing MCP connections (owners call at session end). */
  async close() {
    await this.mcp?.close();
  }
}

export default Gemini;
