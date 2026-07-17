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
import { recordLlmTokens, recordSubagentUsage, finaliseSession } from './usage.js';
import { ChatSession } from './database.js';

// Persisted transcripts are capped: keep the newest entries (with an elision
// marker) so a marathon session can't grow a row without bound.
const TRANSCRIPT_MAX_ENTRIES = 500;

const sessions = new Map();
// A session is created when the chat is opened and consumed when the client's
// websocket connects shortly after; expire it if that never happens.
const PENDING_TTL_MS = Number(process.env.TEXT_CHAT_PENDING_TTL_MS || 120000);
// Hard ceiling on tool round-trips within a single user turn.
const MAX_TOOL_HOPS = Number(process.env.TEXT_CHAT_MAX_TOOL_HOPS || 16);
// After the websocket drops, the session (and its whole LLM conversation)
// survives for this long so a page reload or navigation RE-ATTACHES to it
// instead of starting over — a fresh session re-pays the entire opening seed
// + playbook fetch (15-22k tokens; restart clusters were a top cost in the
// staging usage data) and forgets the conversation.
const REATTACH_GRACE_MS = Number(process.env.TEXT_CHAT_REATTACH_GRACE_MS || 15 * 60 * 1000);
// Frames produced while no socket is attached (a turn finishing across a
// reload) are buffered and flushed on re-attach, so nothing said is lost.
const OUTBOX_CAP = 200;

export function getChatSession(id) {
  return sessions.get(id);
}

/**
 * Create a chat session for a text agent (a DB row or an in-memory definition)
 * and register it. Returns the session; read `session.id` / `/chat/${id}` for
 * the websocket path.
 */
export function createChatSession({ agent, set, testResult, subjectAgent, knowledge, headless, logger = defaultLogger }) {
  const id = crypto.randomUUID();
  const session = new TextChatSession({ id, agent, set, testResult, subjectAgent, knowledge, headless, logger });
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
  constructor({ id, agent, set, testResult, subjectAgent, knowledge, headless, logger }) {
    Object.assign(this, { id, agent, logger });
    // Headless caller (e.g. polite.ai's independent reviewer): drives the agent
    // programmatically over the socket, so SKIP the builder opening turn — the
    // session waits for the caller's first user message instead of auto-running
    // the build/edit/diagnose greeting (which would poison a non-builder agent's
    // context and burn a turn).
    this.headless = !!headless;
    // Billing anchor for this text session: the interaction start. Stamped on
    // every usage row (metadata.startedAt) so cost resolution has a billing
    // instant for rows that have no Call (Q-E). Fixed for the session's life.
    this.startedAt = new Date();
    // Optional seed. `latestSet` is the set the builder is currently working on —
    // primed from an edit/diagnose seed here, then kept current by onToolResults.
    // It also lets `test_agent` resolve a member label to a real agent id.
    this.latestSet = set || null;
    this.seedTestResult = testResult || null;
    // The diagnosed agent's own definition, for a SET-LESS troubleshoot: the
    // builder is asked to propose fixes to the agent, which is guesswork
    // without its prompt/functions/options in front of it.
    this.seedSubjectAgent = subjectAgent || null;
    // Optional pre-formatted context block (e.g. the org's website-knowledge
    // state) supplied by the caller and appended to the hidden opening turn.
    // Opaque to this service — relayed verbatim, never parsed.
    this.seedKnowledge = typeof knowledge === 'string' && knowledge.trim() ? knowledge : null;
    this.functions = Array.isArray(agent.functions)
      ? agent.functions
      : Object.values(agent.functions || {});
    this.connected = false;
    // Tool invokers, scoped to this agent's organisation.
    this.functionOptions = {
      invokeSubagent: (targetId, args, md) => runSubagentById({
        agentId: targetId, input: args, metadata: md,
        organisationId: agent.organisationId, userId: agent.userId, logger,
      }).then((r) => {
        // Attribute a nested subagent's token usage to this chat session.
        recordSubagentUsage({
          sessionId: this.id, organisationId: agent.organisationId, userId: agent.userId,
          usage: r.usage, log: this.logger,
        });
        return r.result;
      }).catch((err) => {
        // A failed subagent still billed tokens — meter them before the error
        // surfaces to the tool loop.
        if (Array.isArray(err?.usage)) {
          recordSubagentUsage({
            sessionId: this.id, organisationId: agent.organisationId, userId: agent.userId,
            usage: err.usage, log: this.logger,
          });
        }
        throw err;
      }),
      createAgentSet: (doc) => createAgentSetForAgent(doc, agent),
      updateAgentSet: (setId, doc) => updateAgentSetForAgent(setId, doc, agent),
      patchAgentSet: (setId, doc) => patchAgentSetForAgent(setId, doc, agent),
      subagentContext: { organisationId: agent.organisationId },
    };
  }

  /**
   * Attach a websocket and run the chat for its lifetime. Called again on
   * RE-ATTACH: after a socket drop the session lingers for REATTACH_GRACE_MS,
   * and a new socket for the same id rebinds to the live conversation — no
   * new seed, no replayed opening turn; buffered frames flush, and a pending
   * interactive ask (ask_user / test) is re-emitted so a freshly loaded UI
   * can answer it. The `attached` frame tells the client which case it got.
   */
  async handleChat(ws) {
    // Single consumer, NEWEST socket wins: an existing socket is closed and
    // the session rebinds to the new one. Rejecting the newcomer instead would
    // strand the user in exactly the case the grace window exists for — after
    // an ungraceful drop (laptop sleep, network switch) the dead socket can
    // read as OPEN for minutes, and there is no heartbeat to prove otherwise.
    // The superseded socket's close handler is a no-op (guarded on
    // `this.ws !== ws`), so takeover can't tear the session down.
    if (this.ws && this.ws !== ws && this.ws.readyState === this.ws.OPEN) {
      const old = this.ws;
      try { old.send(JSON.stringify({ type: 'error', message: 'This session was reconnected elsewhere.' })); } catch { /* dead socket */ }
      try { old.close(); } catch { /* dead socket */ }
    }
    const firstAttach = !this.everConnected;
    this.ws = ws;
    this.connected = true;
    this.everConnected = true;
    clearTimeout(this.expiry);
    clearTimeout(this.graceTimer);
    if (!this.send) {
      this.outbox = [];
      // One canonical sender for the session's lifetime: every turn closure
      // routes through it, so output from a turn that spans a reconnect lands
      // on the CURRENT socket (or the outbox) instead of a dead one.
      this.send = (msg) => {
        if (!this.connected || !this.ws || this.ws.readyState !== this.ws.OPEN) {
          this.outbox.push(msg);
          if (this.outbox.length > OUTBOX_CAP) this.outbox.shift();
          return;
        }
        try { this.ws.send(JSON.stringify(msg)); } catch (e) { this.logger.error(e, 'chat send failed'); }
      };
    }
    const send = this.send;

    // Handlers are registered BEFORE the awaits below: a socket that drops
    // while buildLlm/persist are in flight would otherwise emit 'close' with
    // no listener, so the grace timer would never arm and the session would
    // leak in memory forever.
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'user' && typeof msg.text === 'string') {
        await this.turn(msg.text, send);
      } else if (msg.type === 'test_result' && typeof msg.result === 'string') {
        await this.testResult(msg, send);
      } else if (msg.type === 'review_result' && typeof msg.result === 'string') {
        await this.reviewResult(msg, send);
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return; // superseded by a newer socket
      this.connected = false;
      this.graceTimer = setTimeout(() => this.teardown(), REATTACH_GRACE_MS);
      if (this.graceTimer.unref) this.graceTimer.unref();
    });
    ws.on('error', (e) => this.logger.error(e, 'chat ws error'));

    if (firstAttach) {
      try {
        await this.buildLlm();
      } catch (e) {
        this.logger.error(e, 'chat agent init failed');
        send({ type: 'error', message: `Could not start agent: ${e.message}` });
        ws.close();
        // No LLM was ever built — nothing to re-attach to. Tear down now
        // rather than leaving an llm-less zombie in the registry forever.
        this.teardown();
        return;
      }
      // Durable record of the session (best-effort — persistence must never
      // block the chat): backs the builder's session-history API, and joins
      // token usage on usage_records.session_id. ONLY builder sessions are
      // persisted: this endpoint also serves a tenant's own text agents, and
      // their end-user conversations must not be silently retained (there is
      // no TTL or deletion surface yet). The builder is the builtin, or an
      // org row polite-ai pushes (courtesy marker in the description — the
      // polite-ai dashboard resolves builders by id, but for retention gating
      // the marker + builtin id cover the intended scope).
      const isBuilder =
        this.agent.id === 'builtin:set-builder' ||
        String(this.agent.description || '').includes('[polite:agent-builder]');
      this.transcript = isBuilder ? [] : null;
      if (isBuilder) {
        try {
          await ChatSession.create({
            id: this.id,
            agentId: this.agent.id ?? null,
            organisationId: this.agent.organisationId ?? null,
            userId: this.agent.userId ?? null,
            setId: this.latestSet?.id ?? null,
            mode: this.seedTestResult ? 'troubleshoot' : this.latestSet ? 'edit' : 'new',
            title: this.latestSet?.name ?? null,
            modelName: this.agent.modelName ?? null,
            startedAt: this.startedAt,
            transcript: [],
          });
          this.persisted = true;
        } catch (e) {
          this.logger.error(e, 'chat session persist (create) failed — history disabled for this session');
        }
      }
    }

    // `busy` lets a re-attaching client restore its thinking indicator when a
    // turn is still running from before the drop.
    send({ type: 'attached', resumed: !firstAttach, busy: !!this.busy });
    if (!firstAttach) {
      // A pause reached while detached puts its frame in the outbox AND on
      // this.pending — skip it in the flush (same object) so it arrives once.
      const queued = this.outbox;
      this.outbox = [];
      for (const msg of queued) {
        if (msg !== this.pending?.frame) send(msg);
      }
      // A paused interactive ask was emitted to the old socket — re-emit it so
      // the restored UI shows the question/test card again.
      if (this.pending?.frame) send(this.pending.frame);
      return;
    }

    // Headless caller: no builder opening turn — the caller sends the first user
    // message itself (e.g. the independent reviewer's task). Auto-running the
    // build/edit/diagnose greeting here would poison a non-builder agent's
    // context and waste a turn.
    if (this.headless) return;

    // Open with a hidden turn whose prompt depends on how the session was seeded
    // (build from scratch / edit an existing set / diagnose a test result). Any
    // caller-supplied context block (e.g. website-knowledge state) is appended.
    const opening = this.seedKnowledge
      ? `${this.openingPrompt()}\n\n${this.seedKnowledge}`
      : this.openingPrompt();
    await this.turn(opening, send, true);
  }

  /**
   * Final teardown once the re-attach grace lapses. Usage finalisation
   * (cost-at-finalisation) therefore lags a dropped session by the grace
   * window, and a process exit during grace skips it entirely — both are
   * covered by the nightly uncosted-row sweep (lib/rates.js), which exists as
   * the backstop for exactly this class of exit.
   */
  teardown() {
    if (this.torndown) return; // idempotent — close-after-failed-init double-fires
    this.torndown = true;
    // Bridged drivers hold standing MCP connections — release them or every
    // session leaks a socket per server for the process lifetime.
    Promise.resolve(this.llm?.close?.()).catch(() => {});
    this.finaliseUsage();
    if (this.persisted) {
      ChatSession.update(
        { endedAt: new Date(), transcript: this.transcript, turns: this.turnsCount || 0 },
        { where: { id: this.id } },
      ).catch((e) => this.logger.error(e, 'chat session persist (end) failed'));
    }
    sessions.delete(this.id);
  }

  // The leg-by-leg analysis guidance shared by the opening troubleshoot seed
  // and a mid-session self-initiated test — a `legs` array, one entry per leg.
  static TEST_ANALYSIS_GUIDANCE =
    'The result has a `legs` array with ONE '
    + 'entry per call leg — each with its own agentLabel/agentName, transcript, functions and invocationLog. '
    + 'If the call transferred (transferred:true / more than one leg), there is a separate leg for each agent '
    + 'the call passed through (e.g. reception → sales); analyse EVERY leg, and check the handover itself: did '
    + 'the transfer_agent function fire on the source leg, and did the transferred-to agent pick up and run '
    + 'its own functions on its leg? For each leg ask: did the agent actually speak? did the intended functions '
    + 'fire with the right arguments? are there errors or warnings in the invocation log?';

  /** The hidden opening-turn prompt — build, edit, or diagnose depending on the seed. */
  openingPrompt() {
    const setJson = this.latestSet ? JSON.stringify(this.latestSet) : null;
    // Diagnose whenever a test result is seeded — with or without a set. A set-less
    // agent (a standalone/legacy agent troubleshot from Observe) still has a full
    // test result to analyse; it just can't be patched, so we ask for the fixes in
    // plain language instead of calling patch_agent_set.
    if (this.seedTestResult) {
      const intro = setJson
        ? 'The user has loaded an agent set and just ran a TEST of one of its agents. '
        : 'The user just ran a TEST of an agent. ';
      const apply = setJson
        ? 'propose specific fixes, then apply them with patch_agent_set (using the set id) once the user agrees.'
        : 'propose specific fixes the user can make to the agent (there is no saved agent set for this agent, '
          + 'so describe the changes rather than calling patch_agent_set).';
      // Set-less troubleshoot: ground the diagnosis in the agent's own
      // definition — without it, prompt/function root-causing is guesswork
      // against half the evidence. An array means one definition per distinct
      // agent on the call (a transfer chain between standalone agents).
      const subject = !setJson && this.seedSubjectAgent
        ? (Array.isArray(this.seedSubjectAgent)
          ? `\n\nCURRENT AGENT DEFINITIONS (JSON — one per distinct agent on the call, root first):\n${JSON.stringify(this.seedSubjectAgent)}`
          : `\n\nCURRENT AGENT DEFINITION (JSON):\n${JSON.stringify(this.seedSubjectAgent)}`)
        : '';
      const context = setJson
        ? `\n\nCURRENT SET (JSON):\n${setJson}\n\nTEST RESULT (JSON):\n${JSON.stringify(this.seedTestResult)}`
        : `${subject}\n\nTEST RESULT (JSON):\n${JSON.stringify(this.seedTestResult)}`;
      return intro
        + 'Greet very briefly, then analyse the test result below. '
        + TextChatSession.TEST_ANALYSIS_GUIDANCE
        + ' Explain what you find '
        + 'in plain language and ' + apply + context;
    }
    if (setJson) {
      // A seeded set with NO members is a freshly pre-created placeholder (the
      // polite-ai builder persists the team before the chat starts): this is a
      // BUILD conversation, not an edit of something that exists — and the one
      // set this session may write to is the placeholder itself.
      if (!Array.isArray(this.latestSet?.agents) || this.latestSet.agents.length === 0) {
        return 'The user wants to BUILD a new agent team. An empty placeholder set has already been '
          + 'created for it — build INTO that set: save with patch_agent_set or update_agent_set using '
          + 'its id, and NEVER call create_agent_set in this session. Greet briefly and ask what the '
          + 'team should do. As soon as the reply identifies the subject domain, propose a real name: '
          + 'call ask_user with 2–3 short candidates tailored to their business (the user can always '
          + 'type their own), then save the choice straight away with a name-only patch_agent_set '
          + '({id, name}) before building further — the team must not stay "Untitled team" beyond '
          + 'your first save.\n\n'
          + `CURRENT SET (JSON):\n${setJson}`;
      }
      return 'The user wants to EDIT this existing agent set. Greet briefly, summarise it in one short line '
        + '(name and member labels), and ask what they would like to change or test. For routine edits revise it '
        + 'with patch_agent_set (use its id; send only the members you are changing), reserving update_agent_set '
        + 'for a wholesale restructure, and you may offer to test a voice member with test_agent.\n\n'
        + `CURRENT SET (JSON):\n${setJson}`;
    }
    return 'Greet me briefly and ask what agent set I would like to build.';
  }

  /**
   * Framing for a SELF-INITIATED (manual, action-bar) in-browser test result:
   * diagnosed mid-session as a HIDDEN turn (so the bundle never enters the
   * durable transcript / the ongoing user-visible context). Unlike the opening
   * troubleshoot seed it neither greets nor re-embeds the set — the builder
   * already holds the current team.
   */
  manualTestDiagnosePrompt(resultJson) {
    return 'The user just ran a live in-browser TEST of the current team. Analyse the test result below. '
      + TextChatSession.TEST_ANALYSIS_GUIDANCE
      + ' Explain what you find in plain language, fix it with patch_agent_set (using the set id), and offer to re-test.'
      + `\n\nTEST RESULT (JSON):\n${resultJson}`;
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
      // Human-paced session: drivers that cache the prompt prefix may use a
      // long TTL (a think-pause or test call outlives the 5m default).
      interactive: true,
    });
  }

  /**
   * Run one user turn. Turns are serialised per session so a message that
   * arrives mid-turn queues behind the current one rather than interleaving on
   * the shared conversation state.
   */
  turn(userText, send, hidden = false) {
    // Claim any pending tool call at ENQUEUE (frame arrival), not when the
    // queued turn eventually runs: a pending created by an intervening turn
    // (the model pausing again while this message waited in the queue) must
    // never capture a message that predates it.
    // EXCEPT when older turns are still queued: they run first, and if this
    // message took the claim they would hit rawCompletion while the pause's
    // tool call dangles unanswered — the provider 400s and the session wedges.
    // Leaving the pending in place lets the OLDEST queued turn claim it at
    // run time (runTurn's fallback), which answers the tool call API-validly.
    const claimed = this.queuedTurns ? null : this.pending;
    if (claimed) this.pending = null;
    this.queuedTurns = (this.queuedTurns || 0) + 1;
    this.queue = (this.queue || Promise.resolve())
      .then(() => this.runTurn(userText, send, hidden, claimed))
      .catch((e) => this.logger.error(e, 'chat turn chain error'));
    return this.queue;
  }

  async runTurn(userText, send, hidden = false, claimed = null) {
    this.busy = true;
    if (!hidden) {
      this.turnsCount = (this.turnsCount || 0) + 1;
      this.record('user', userText);
      send({ type: 'user_echo', text: userText });
    }
    send({ type: 'status', state: 'thinking' });
    this.logger.info({ id: this.id, hidden, resume: !!claimed }, 'chat turn started');
    // Surface server-side MCP tool calls (the builder reading the Aplisay
    // docs/API) so the user sees progress during the slow connector round trips.
    const onLlmEvent = (ev) => {
      if (ev && ev.mcp_tool_use) {
        send({ type: 'tool_call', calls: [{ name: ev.mcp_tool_use.name, server: ev.mcp_tool_use.server, mcp: true }] });
      }
      // A client tool call the model has STARTED generating (streaming drivers
      // surface the name at block start, tens of seconds before a big set
      // save's arguments finish). Lets the builder UI treat the canvas as
      // provisional for the whole generation window, not just the save round
      // trip — the definitive tool_call frame (with input) still follows once
      // generation completes, and clients handle the repeat idempotently.
      if (ev && typeof ev.tool_use_start?.name === 'string' && ev.tool_use_start.name) {
        send({ type: 'tool_call', calls: [{ name: ev.tool_use_start.name }], streaming: true });
      }
    };
    try {
      // A pending created AFTER this message was queued (the model paused again
      // while this turn waited in the queue) must still be answered — the LLM
      // API rejects a plain user message while a tool call dangles. ask_user
      // keeps its legacy semantics (the user's text IS the answer); a test
      // pause is declined, with the user's message carried inside the result.
      let pending = claimed;
      if (!pending && this.pending) {
        pending = this.pending;
        this.pending = null;
        if (pending.platform === 'test_agent' || pending.platform === 'request_review') {
          userText = JSON.stringify({
            ok: false,
            reason: `The user continued the conversation instead of ${pending.platform === 'request_review' ? 'running the review' : 'running the test'}. Their message follows.`,
            userMessage: userText,
          });
        }
      }
      let round;
      if (pending) {
        // This message answers the pending tool call; resume the agent's tool
        // loop by returning the answer (plus any sibling results) as tool_results.
        const { toolUseId, toolName, otherResults } = pending;
        // `name` rides along for drivers whose provider needs the function
        // NAME on tool results (Gemini functionResponse) — its ids are often
        // absent, so name recovery from history alone is unreliable.
        round = await this.llm.callResult(
          [...(otherResults || []), { id: toolUseId, ...(toolName ? { name: toolName } : {}), result: userText }],
          onLlmEvent);
      } else {
        round = await this.llm.rawCompletion(userText, onLlmEvent);
      }
      this.recordRoundUsage(round);
      for (let hop = 0; hop < MAX_TOOL_HOPS; hop += 1) {
        if (round.text) {
          this.record('agent', round.text);
          send({ type: 'agent', text: round.text });
        }
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
              name: c.name,
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
            this.recordRoundUsage(round);
            continue;
          }
          // Some builtins pause the turn for a user-driven step, resuming when the
          // next user message (or result frame) arrives: ask_user (emit a question),
          // test_agent (open the test widget; the frontend returns the call's
          // transcript/logs), and request_review (the client runs polite.ai's
          // independent review and returns its findings). Each resumes via
          // callResult with the reply/result as this tool's result.
          const pause = round.calls.find((c) => ['ask_user', 'test_agent', 'request_review'].includes(this.platformOf(c.name)));
          if (pause) {
            const others = round.calls.filter((c) => c !== pause);
            let otherResults = [];
            if (others.length) {
              send({ type: 'tool_call', calls: others.map(({ name, input }) => ({ name, input })) });
              const res = await functionHandler(
                others, this.functions, this.agent.keys || [],
                (m) => this.onToolResults(m, send), {}, {}, this.functionOptions);
              otherResults = this.slimResults(res.function_results || []);
            }
            // The pause frame is kept on the pending record so a client that
            // re-attaches after a drop can be shown the ask again.
            let frame;
            const pausePlatform = this.platformOf(pause.name);
            if (pausePlatform === 'test_agent') {
              const label = pause.input?.label;
              const member = (this.latestSet?.agents || []).find((a) => a.label === label);
              frame = { type: 'test', id: pause.id, label, agentId: member?.id || null, name: member?.name || label };
            } else if (pausePlatform === 'request_review') {
              // The client runs polite.ai's independent review of the current set
              //  and answers with a review_result frame carrying its findings.
              frame = { type: 'review', id: pause.id };
            } else {
              frame = {
                type: 'question',
                id: pause.id,
                question: pause.input?.question || '',
                options: Array.isArray(pause.input?.options) ? pause.input.options : [],
                multiSelect: !!pause.input?.multiSelect,
              };
            }
            this.pending = { toolUseId: pause.id, toolName: pause.name, otherResults, platform: this.platformOf(pause.name), frame };
            // The ask is part of the conversation — without it, the persisted
            // transcript shows answers to invisible questions.
            this.record(
              'agent',
              frame.type === 'question'
                ? `${frame.question}${frame.options?.length ? ` (options: ${frame.options.join(' / ')})` : ''}`
                : frame.type === 'review'
                  ? '[requested an independent review of the set]'
                  : `[offered a live in-browser test of “${frame.name}”]`,
            );
            send(frame);
            return; // paused — the next user message resumes this turn
          }
          send({ type: 'tool_call', calls: round.calls.map(({ name, input }) => ({ name, input })) });
          const { function_results } = await functionHandler(
            round.calls, this.functions, this.agent.keys || [],
            (m) => this.onToolResults(m, send),
            {}, {}, this.functionOptions);
          round = await this.llm.callResult(this.slimResults(function_results), onLlmEvent);
          this.recordRoundUsage(round);
          continue;
        }
        break; // no tool calls — the agent is waiting for the user
      }
    } catch (e) {
      // A failed turn (e.g. the LLM/MCP call timing out) must not leave a
      // dangling ask_user pending, or the next message would try to resume a
      // turn that no longer exists.
      this.pending = null;
      // Drivers attach the usage of hops that completed before the failure —
      // those tokens were billed by the provider, so meter them.
      if (e?.usage && !Array.isArray(e.usage)) this.recordRoundUsage({ usage: e.usage });
      // The abort may have left the driver's history ending in unanswered
      // tool calls, which the provider rejects on EVERY later request. Only
      // the turn owner can declare the turn dead — drivers must not guess
      // (the unserialised voice path has live in-flight calls that look
      // identical). Synthesize error results so the session stays usable.
      try { this.llm?.abandonTurn?.(); } catch (err) { this.logger.warn(err, 'abandonTurn failed'); }
      this.logger.error(e, 'chat turn failed');
      this.record('system', `Turn failed: ${e.message}`);
      send({ type: 'error', message: e.message });
    } finally {
      this.queuedTurns = Math.max(0, (this.queuedTurns || 1) - 1);
      this.busy = false;
      send({ type: 'turn_complete' });
      this.persistTurn(); // fire-and-forget — history must never block the chat
    }
  }

  /** Append a transcript entry for the durable session record (capped). */
  record(role, text) {
    if (!this.transcript || typeof text !== 'string' || !text) return;
    this.transcript.push({ role, text, at: new Date().toISOString() });
    const excess = this.transcript.length - TRANSCRIPT_MAX_ENTRIES;
    if (excess > 0) {
      this.transcript.splice(0, excess + 1, {
        role: 'system',
        text: '[… earlier conversation trimmed …]',
        at: this.transcript[excess]?.at,
      });
    }
  }

  /** Best-effort per-turn flush of the durable session record. */
  persistTurn() {
    if (!this.persisted) return;
    ChatSession.update(
      {
        transcript: this.transcript,
        turns: this.turnsCount || 0,
        // A new-team session gains its set at the first save; keep the row
        // pointing at the latest identity the canvas is showing.
        setId: this.latestSet?.id ?? null,
        title: this.latestSet?.name ?? null,
      },
      { where: { id: this.id } },
    ).catch((e) => this.logger.error(e, 'chat session persist (update) failed'));
  }

  /**
   * Handle an explicit `test_result` frame ({type:'test_result', id?, result})
   * — the unambiguous channel for clients that drive their own in-browser test
   * flow (polite-ai). Two shapes:
   *  - WITH a matching `id`: answers a paused test_agent tool call the builder
   *    OFFERED. The id must match the pending tool-use id so a stale/duplicate
   *    frame can't hijack an unrelated turn. The result rides the tool-call
   *    context, so it resumes the turn verbatim (hidden).
   *  - WITHOUT an `id` and with NO pending call: a SELF-INITIATED (manual,
   *    action-bar) test. There's no tool-call context to say this JSON is a
   *    test result, so it's framed as a diagnose turn — and run HIDDEN, so the
   *    bundle stays out of the durable transcript and the ongoing user context.
   * The legacy protocol — the next plain `user` message resumes a pending call
   * (llm-frontend) — is unchanged; a client using the id form must send it
   * BEFORE any queued user text so the paused turn consumes the result.
   */
  testResult(msg, send) {
    if (this.pending && msg.id === this.pending.toolUseId) {
      return this.turn(msg.result, send, true);
    }
    if (!msg.id && !this.pending) {
      return this.turn(this.manualTestDiagnosePrompt(msg.result), send, true);
    }
    this.logger.warn({ id: this.id, frameId: msg.id }, 'test_result without a matching pending tool call — ignored');
    return Promise.resolve();
  }

  /**
   * Handle a `review_result` frame ({type:'review_result', id, result}) — the
   * client answering a paused `request_review` tool call with polite.ai's
   * independent-review findings. The id must match the pending tool-use id so a
   * stale/duplicate frame can't hijack an unrelated turn; the findings ride the
   * tool-call context, resuming the builder's turn HIDDEN so it can weigh them
   * and patch. There is no id-less form — a user-initiated review is fed back as
   * a normal message by the client, not through here.
   */
  reviewResult(msg, send) {
    if (this.pending && msg.id === this.pending.toolUseId) {
      return this.turn(msg.result, send, true);
    }
    this.logger.warn({ id: this.id, frameId: msg.id }, 'review_result without a matching pending tool call — ignored');
    return Promise.resolve();
  }

  /** Record this round's LLM token usage against the chat session (best-effort). */
  recordRoundUsage(round) {
    const u = round?.usage;
    if (!u) return;
    recordLlmTokens({
      sessionId: this.id,
      organisationId: this.agent.organisationId,
      userId: this.agent.userId,
      agentId: this.agent.id,
      provider: u.provider, model: u.model,
      inputTokens: u.inputTokens, outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens,
      metadata: { startedAt: this.startedAt.toISOString() },
      mode: 'increment',
      log: this.logger,
    });
  }

  /**
   * Finalise this session's usage meters at session end (websocket close). The
   * interactive text path accumulates token rows with mode:'increment' and never
   * sets `finalised`, so this is its transaction-end signal — it lets cost-at-
   * finalisation fire (with the nightly sweep as a backstop). Best-effort.
   */
  finaliseUsage() {
    return finaliseSession(this.id, { log: this.logger });
  }

  /** The builtin platform of one of this agent's functions, by name. */
  platformOf(name) {
    const fn = this.functions.find((f) => f.name === name);
    return fn && fn.platform;
  }

  /**
   * Shrink set-mutation tool results before they enter the LLM conversation.
   * A save's full rendered set (2-15KB) is only needed by the ws `set` frame
   * and latestSet — both fed the full result via onToolResults BEFORE this
   * runs. The model gets a confirmation stub instead: it already holds what it
   * just sent as the tool_use arguments, and the stub carries the post-save
   * identities (set id, member ids) that label resolution produced. Without
   * this, every save echo rides the conversation for the rest of the session —
   * an iterative build carries ~20-25k tokens of near-duplicate set snapshots.
   * Save FAILURES (an `{ error }` result) pass through untouched — the model
   * must read those verbatim to correct the payload.
   */
  static SET_PLATFORMS = new Set(['create_agent_set', 'update_agent_set', 'patch_agent_set']);

  slimResults(results) {
    return (results || []).map((r) => {
      if (!TextChatSession.SET_PLATFORMS.has(this.platformOf(r.name))) return r;
      try {
        const parsed = JSON.parse(r.result);
        if (!parsed || !Array.isArray(parsed.agents)) return r;
        return {
          ...r,
          result: JSON.stringify({
            saved: true,
            id: parsed.id,
            name: parsed.name,
            members: parsed.agents.map((a) => ({ label: a.label, id: a.id, name: a.name })),
          }),
        };
      } catch {
        return r; // non-JSON result — pass through
      }
    });
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
