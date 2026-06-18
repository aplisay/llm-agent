/**
 * Interactive, turn-by-turn chat sessions for `text` type agents.
 *
 * Unlike a voice listener there is no audio leg, no telephony and nothing worth
 * persisting, so a chat session is held in memory (not as a DB `Instance`) and
 * keyed by a generated id. The flow mirrors `listen`: a caller creates a session
 * and gets back a websocket path (`/chat/<id>`); the ws upgrade in
 * `ws-handler.js` looks the session up here and hands it the socket.
 *
 * Each user message drives the same LLM/tool loop the headless subagent uses
 * (`llm.completion` → dispatch tools via `functionHandler` → `llm.callResult`),
 * but the loop pauses for the next user turn whenever the model replies without
 * a tool call. Tool activity (including a created/updated agent set) is streamed
 * to the client as it happens.
 */
import crypto from 'crypto';
import defaultLogger from './logger.js';
import handlers from './handlers/index.js';
import { functionHandler } from './function-handler.js';
import { llmFunctions, runSubagentById } from './subagent.js';
import { createAgentSetForAgent, updateAgentSetForAgent } from './agent-set-service.js';

const sessions = new Map();
// A session is created when the chat is opened and consumed when the client's
// websocket connects shortly after; expire it if that never happens.
const PENDING_TTL_MS = Number(process.env.TEXT_CHAT_PENDING_TTL_MS || 120000);
// Hard ceiling on tool round-trips within a single user turn.
const MAX_TOOL_HOPS = Number(process.env.TEXT_CHAT_MAX_TOOL_HOPS || 16);

export function getChatSession(id) {
  return sessions.get(id);
}

/**
 * Create a chat session for a text agent (a DB row or an in-memory definition)
 * and register it. Returns the session; read `session.id` / `/chat/${id}` for
 * the websocket path.
 */
export function createChatSession({ agent, logger = defaultLogger }) {
  const id = crypto.randomUUID();
  const session = new TextChatSession({ id, agent, logger });
  sessions.set(id, session);
  session.expiry = setTimeout(() => {
    if (!session.connected) sessions.delete(id);
  }, PENDING_TTL_MS);
  if (session.expiry.unref) session.expiry.unref();
  return session;
}

function interactiveSystemPrompt(agent) {
  return `${agent.prompt || ''}\n\n` +
    'You are in a live, turn-by-turn text chat with a user. Converse naturally: ask ' +
    'clarifying questions when you need to and wait for the user\'s reply between turns. ' +
    'Use your tools when they help and briefly tell the user what you are doing. Do not ' +
    'invent facts you could look up.';
}

class TextChatSession {
  constructor({ id, agent, logger }) {
    Object.assign(this, { id, agent, logger });
    this.functions = Array.isArray(agent.functions)
      ? agent.functions
      : Object.values(agent.functions || {});
    this.connected = false;
    // Tool invokers, scoped to this agent's organisation.
    this.functionOptions = {
      invokeSubagent: (targetId, args, md) => runSubagentById({
        agentId: targetId, input: args, metadata: md,
        organisationId: agent.organisationId, userId: agent.userId, logger,
      }).then(({ result }) => result),
      createAgentSet: (doc) => createAgentSetForAgent(doc, agent),
      updateAgentSet: (setId, doc) => updateAgentSetForAgent(setId, doc, agent),
      subagentContext: { organisationId: agent.organisationId },
    };
  }

  /** Attach a websocket and run the chat for its lifetime. */
  async handleChat(ws) {
    this.connected = true;
    clearTimeout(this.expiry);
    const send = (msg) => {
      try { ws.send(JSON.stringify(msg)); } catch (e) { this.logger.error(e, 'chat send failed'); }
    };

    try {
      await this.buildLlm();
    } catch (e) {
      this.logger.error(e, 'chat agent init failed');
      send({ type: 'error', message: `Could not start agent: ${e.message}` });
      ws.close();
      return;
    }

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'user' && typeof msg.text === 'string') {
        await this.turn(msg.text, send);
      }
    });
    ws.on('close', () => sessions.delete(this.id));
    ws.on('error', (e) => this.logger.error(e, 'chat ws error'));

    // Open with a greeting (driven as a hidden user turn).
    await this.turn('Greet me briefly and ask what agent set I would like to build.', send, true);
  }

  async buildLlm() {
    const { getHandler } = await handlers();
    const Handler = getHandler(this.agent.modelName);
    if (!Handler) throw new Error(`Unknown model name: ${this.agent.modelName}`);
    const { implementation: Implementation } = Handler.parseName(this.agent.modelName);
    if (!Implementation) throw new Error(`No LLM implementation for ${this.agent.modelName}`);
    this.llm = new Implementation({
      logger: this.logger,
      user: `chat-${this.agent.id}`,
      prompt: interactiveSystemPrompt(this.agent),
      functions: llmFunctions(this.functions),
      keys: this.agent.keys,
      options: this.agent.options,
      modelName: this.agent.modelName,
      model: this.agent.modelName,
      mcpServers: this.agent.mcpServers,
    });
  }

  /** Run one user turn to completion (until the model yields without a tool call). */
  async turn(userText, send, hidden = false) {
    if (!hidden) send({ type: 'user_echo', text: userText });
    send({ type: 'status', state: 'thinking' });
    try {
      let round = await this.llm.completion(userText);
      for (let hop = 0; hop < MAX_TOOL_HOPS; hop += 1) {
        if (round.error) {
          send({ type: 'error', message: String(round.error) });
          return;
        }
        if (round.text) send({ type: 'agent', text: round.text });
        if (round.calls && round.calls.length) {
          send({ type: 'tool_call', calls: round.calls.map(({ name, input }) => ({ name, input })) });
          const { function_results } = await functionHandler(
            round.calls, this.functions, this.agent.keys || [],
            (m) => this.onToolResults(m, send),
            {}, {}, this.functionOptions);
          round = await this.llm.callResult(function_results);
          continue;
        }
        break; // no tool calls — the agent is waiting for the user
      }
    } catch (e) {
      this.logger.error(e, 'chat turn failed');
      send({ type: 'error', message: e.message });
    } finally {
      send({ type: 'turn_complete' });
    }
  }

  /** Forward tool results, and surface a created/updated set as a typed event. */
  onToolResults(message, send) {
    if (!message.function_results) return;
    send({ type: 'tool_result', results: message.function_results });
    message.function_results.forEach((r) => {
      const fn = this.functions.find((f) => f.name === r.name);
      if (fn && (fn.platform === 'create_agent_set' || fn.platform === 'update_agent_set')) {
        try { send({ type: 'set', set: JSON.parse(r.result) }); } catch { /* non-JSON result */ }
      }
    });
  }
}
