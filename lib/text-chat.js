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
import { createAgentSetForAgent, updateAgentSetForAgent, patchAgentSetForAgent } from './agent-set-service.js';

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
export function createChatSession({ agent, set, testResult, logger = defaultLogger }) {
  const id = crypto.randomUUID();
  const session = new TextChatSession({ id, agent, set, testResult, logger });
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
  constructor({ id, agent, set, testResult, logger }) {
    Object.assign(this, { id, agent, logger });
    // Optional seed. `latestSet` is the set the builder is currently working on —
    // primed from an edit/diagnose seed here, then kept current by onToolResults.
    // It also lets `test_agent` resolve a member label to a real agent id.
    this.latestSet = set || null;
    this.seedTestResult = testResult || null;
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
      patchAgentSet: (setId, doc) => patchAgentSetForAgent(setId, doc, agent),
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

    // Open with a hidden turn whose prompt depends on how the session was seeded
    // (build from scratch / edit an existing set / diagnose a test result).
    await this.turn(this.openingPrompt(), send, true);
  }

  /** The hidden opening-turn prompt — build, edit, or diagnose depending on the seed. */
  openingPrompt() {
    const setJson = this.latestSet ? JSON.stringify(this.latestSet) : null;
    if (this.seedTestResult && setJson) {
      return 'The user has loaded an agent set and just ran a TEST of one of its agents. '
        + 'Greet very briefly, then analyse the test result below. The result has a `legs` array with ONE '
        + 'entry per call leg — each with its own agentLabel/agentName, transcript, functions and invocationLog. '
        + 'If the call transferred (transferred:true / more than one leg), there is a separate leg for each agent '
        + 'the call passed through (e.g. reception → sales); analyse EVERY leg, and check the handover itself: did '
        + 'the transfer_agent function fire on the source leg, and did the transferred-to agent pick up and run '
        + 'its own functions on its leg? For each leg ask: did the agent actually speak? did the intended functions '
        + 'fire with the right arguments? are there errors or warnings in the invocation log? Explain what you find '
        + 'in plain language and propose specific fixes, then apply them with patch_agent_set (using the set id) '
        + `once the user agrees.\n\nCURRENT SET (JSON):\n${setJson}\n\nTEST RESULT (JSON):\n${JSON.stringify(this.seedTestResult)}`;
    }
    if (setJson) {
      return 'The user wants to EDIT this existing agent set. Greet briefly, summarise it in one short line '
        + '(name and member labels), and ask what they would like to change or test. Revise it with '
        + 'update_agent_set (use its id), and you may offer to test a voice member with test_agent.\n\n'
        + `CURRENT SET (JSON):\n${setJson}`;
    }
    return 'Greet me briefly and ask what agent set I would like to build.';
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

  /**
   * Run one user turn. Turns are serialised per session so a message that
   * arrives mid-turn queues behind the current one rather than interleaving on
   * the shared conversation state.
   */
  turn(userText, send, hidden = false) {
    this.queue = (this.queue || Promise.resolve())
      .then(() => this.runTurn(userText, send, hidden))
      .catch((e) => this.logger.error(e, 'chat turn chain error'));
    return this.queue;
  }

  async runTurn(userText, send, hidden = false) {
    if (!hidden) send({ type: 'user_echo', text: userText });
    send({ type: 'status', state: 'thinking' });
    this.logger.info({ id: this.id, hidden, resume: !!this.pending }, 'chat turn started');
    // Surface server-side MCP tool calls (the builder reading the Aplisay
    // docs/API) so the user sees progress during the slow connector round trips.
    const onLlmEvent = (ev) => {
      if (ev && ev.mcp_tool_use) {
        send({ type: 'tool_call', calls: [{ name: ev.mcp_tool_use.name, server: ev.mcp_tool_use.server, mcp: true }] });
      }
    };
    try {
      let round;
      if (this.pending) {
        // This message answers a pending ask_user; resume the agent's tool loop
        // by returning the answer (plus any sibling tool results) as tool_results.
        const { toolUseId, otherResults } = this.pending;
        this.pending = null;
        round = await this.llm.callResult([...otherResults, { id: toolUseId, result: userText }], onLlmEvent);
      } else {
        round = await this.llm.rawCompletion(userText, onLlmEvent);
      }
      for (let hop = 0; hop < MAX_TOOL_HOPS; hop += 1) {
        if (round.text) send({ type: 'agent', text: round.text });
        if (round.calls && round.calls.length) {
          // A tool call truncated at the output-token limit (stop_reason
          // "max_tokens") has incomplete arguments — a large field such as the
          // agents array is cut off and silently dropped, leaving only {id}.
          // Dispatching it fails with a misleading validation error ("non-empty
          // agents array"), and the model — told only that the array was empty —
          // resends the SAME oversized call and truncates again. Instead, answer
          // the truncated call(s) with an accurate diagnosis so the model shrinks
          // the payload rather than blindly retrying.
          if (round.truncated) {
            this.logger.warn(
              { id: this.id, calls: round.calls.map((c) => c.name) },
              'tool call truncated at output-token limit; returning truncation notice');
            const results = round.calls.map((c) => ({
              id: c.id,
              result: JSON.stringify({
                error: 'TRUNCATED: your previous response reached the output token limit before the tool call '
                  + 'finished, so its arguments were cut off and could not be used (a large field such as the '
                  + 'agents array was incomplete and dropped). Do NOT resend the same call unchanged — it will '
                  + 'truncate again. Make the payload smaller: tighten the agent prompts and put the tool call '
                  + 'first with no prose before it, then call the tool again.',
              }),
            }));
            send({ type: 'tool_result', results: results.map((r) => ({ name: 'truncated', result: r.result })) });
            round = await this.llm.callResult(results, onLlmEvent);
            continue;
          }
          // Some builtins pause the turn for a user-driven step, resuming when the
          // next user message arrives: ask_user (emit a question) and test_agent
          // (open the test widget; the frontend returns the call's transcript/logs).
          // Both resume via callResult with the user's reply as this tool's result.
          const pause = round.calls.find((c) => ['ask_user', 'test_agent'].includes(this.platformOf(c.name)));
          if (pause) {
            const others = round.calls.filter((c) => c !== pause);
            let otherResults = [];
            if (others.length) {
              send({ type: 'tool_call', calls: others.map(({ name, input }) => ({ name, input })) });
              const res = await functionHandler(
                others, this.functions, this.agent.keys || [],
                (m) => this.onToolResults(m, send), {}, {}, this.functionOptions);
              otherResults = res.function_results || [];
            }
            this.pending = { toolUseId: pause.id, otherResults };
            if (this.platformOf(pause.name) === 'test_agent') {
              const label = pause.input?.label;
              const member = (this.latestSet?.agents || []).find((a) => a.label === label);
              send({ type: 'test', id: pause.id, label, agentId: member?.id || null, name: member?.name || label });
            } else {
              send({
                type: 'question',
                id: pause.id,
                question: pause.input?.question || '',
                options: Array.isArray(pause.input?.options) ? pause.input.options : [],
                multiSelect: !!pause.input?.multiSelect,
              });
            }
            return; // paused — the next user message resumes this turn
          }
          send({ type: 'tool_call', calls: round.calls.map(({ name, input }) => ({ name, input })) });
          const { function_results } = await functionHandler(
            round.calls, this.functions, this.agent.keys || [],
            (m) => this.onToolResults(m, send),
            {}, {}, this.functionOptions);
          round = await this.llm.callResult(function_results, onLlmEvent);
          continue;
        }
        break; // no tool calls — the agent is waiting for the user
      }
    } catch (e) {
      // A failed turn (e.g. the LLM/MCP call timing out) must not leave a
      // dangling ask_user pending, or the next message would try to resume a
      // turn that no longer exists.
      this.pending = null;
      this.logger.error(e, 'chat turn failed');
      send({ type: 'error', message: e.message });
    } finally {
      send({ type: 'turn_complete' });
    }
  }

  /** The builtin platform of one of this agent's functions, by name. */
  platformOf(name) {
    const fn = this.functions.find((f) => f.name === name);
    return fn && fn.platform;
  }

  /** Forward tool results, and surface a created/updated set as a typed event. */
  onToolResults(message, send) {
    if (!message.function_results) return;
    send({ type: 'tool_result', results: message.function_results });
    message.function_results.forEach((r) => {
      const fn = this.functions.find((f) => f.name === r.name);
      if (fn && (fn.platform === 'create_agent_set' || fn.platform === 'update_agent_set' || fn.platform === 'patch_agent_set')) {
        try {
          const parsed = JSON.parse(r.result);
          // Only a real set (has a members array) is a save; a failed create/update
          // now returns `{ error }`, which must not look like a saved set.
          if (parsed && Array.isArray(parsed.agents)) {
            this.latestSet = parsed; // keep test_agent label→id resolution current
            send({ type: 'set', set: parsed });
          }
        } catch { /* non-JSON result */ }
      }
    });
  }
}
