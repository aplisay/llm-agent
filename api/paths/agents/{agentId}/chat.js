import { createChatSession } from '../../../../lib/text-chat.js';
import { resolveAgentForUser } from '../../../../lib/builtin-agents.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { isModelAllowed } from '../../../../lib/auth/model-access.js';
import TextHandler from '../../../../lib/handlers/text.js';

let log;

export default function (logger) {
  log = logger;
  return {
    POST: agentChat,
  };
}

/**
 * Start an interactive, turn-by-turn chat session with a `text` agent — a stored
 * agent or a read-only built-in (e.g. the set builder) — and return the
 * websocket path to open. This is the interactive counterpart to the one-shot
 * POST /agents/{agentId}/invoke; both run the same agent, one turn-by-turn and
 * the other to completion.
 */
const agentChat = async (req, res) => {
  const { agentId } = req.params;
  if (!requirePermission(res, 'agent', 'invoke')) return;
  try {
    const { agent, builtin } = await resolveAgentForUser(agentId, res.locals.user);
    if (!agent) {
      return res.status(404).send({ message: `Agent with ID ${agentId} not found` });
    }
    // R1/F7 — built-ins are gated by their `builtin:<id>` access prefix.
    if (builtin && !isModelAllowed(agentId, res.locals.user?._allowedModels)) {
      return res.status(404).send({ message: `Agent with ID ${agentId} not found` });
    }
    // R1 — RUNNING a stored agent is gated on its model, matching agentGet's
    // read gate: an allow-list tightened after the agent was created (or a
    // member with a narrower personal list than the agent's author) must not
    // keep running a now-disallowed model on the org's bill. The per-session
    // override below cannot rescue a disallowed base agent — if you may not
    // read it, you may not run it.
    // The org-pushed builder is a stored agent and IS gated here (it has no
    // forgeable-free exemption — the description marker is tenant-settable via
    // agentCreate, so trusting it would be a bypass). A restrictively-scoped
    // org instead reaches the builder through the BUILTIN (gated by its
    // `builtin:set-builder` access id, not its model): polite-ai retries the
    // chat against the builtin on a 403, so an org granted `builtin:` keeps a
    // working builder while its own pushed row is correctly policy-gated.
    if (!builtin && !isModelAllowed(agent.modelName, res.locals.user?._allowedModels)) {
      return res.status(403).send({ message: 'model_not_permitted', detail: `Model ${agent.modelName} is not permitted for your account.` });
    }
    if ((agent.type || 'interactive-audio') !== 'text') {
      return res.status(400).send({
        message: `Agent ${agentId} is type ${agent.type || 'interactive-audio'}; only text agents support chat`,
      });
    }
    // Optional seed: an existing set to edit, a prior test result to diagnose,
    // the diagnosed agent's own definition (a SET-LESS troubleshoot — without
    // it the builder root-causes prompt/function bugs blind), and/or a
    // caller-formatted context block (e.g. website-knowledge state) appended
    // verbatim to the opening turn.
    const { set, testResult, subjectAgent, knowledge, model, headless } = req.body || {};
    // Optional per-SESSION model override (e.g. a user's builder-model
    // preference). Two gates: the id must be a loadable `text:` catalogue
    // model, and the caller must be allowed to use it. The override is set
    // in-memory on the resolved agent (never saved) so the LLM build and the
    // persisted ChatSession.modelName both reflect the model that actually ran.
    if (model) {
      const known = TextHandler.availableModels.some((m) => m.name === model);
      if (!known) {
        return res.status(400).send({ message: `Unknown text model: ${model}` });
      }
      if (!isModelAllowed(model, res.locals.user?._allowedModels)) {
        return res.status(403).send({ message: `Model not permitted: ${model}` });
      }
      agent.modelName = model;
    }
    const session = createChatSession({ agent, set, testResult, subjectAgent, knowledge, headless, logger: req.log });
    log.info(
      { agentId, sessionId: session.id, edit: !!set, diagnose: !!testResult, subjectAgent: !!subjectAgent, knowledge: !!knowledge, headless: !!headless, model: model || undefined },
      'agent chat session started');
    res.send({ id: session.id, socket: `/chat/${session.id}` });
  }
  catch (err) {
    req.log.error(err, 'starting agent chat');
    res.status(500).send({ message: err.message });
  }
};

agentChat.apiDoc = {
  summary: 'Starts an interactive turn-by-turn chat session with a text agent.',
  description: `Opens a live chat with a \`text\` agent (a stored agent, or a read-only built-in such as the
                set builder). Returns a websocket path; open it, then send \`{"type":"user","text":"..."}\`
                messages and receive \`agent\` / \`tool_call\` / \`tool_result\` / \`set\` / \`turn_complete\` /
                \`error\` events. The interactive counterpart to the one-shot POST /agents/{agentId}/invoke.`,
  operationId: 'chatAgent',
  tags: ['Agent'],
  parameters: [
    {
      description: 'ID of the text agent to chat with (a stored agent id or a built-in id)',
      in: 'path',
      name: 'agentId',
      required: true,
      schema: { type: 'string' },
    },
  ],
  requestBody: {
    description: 'Optional seed for the session: an existing set to edit, and/or a prior test result to diagnose.',
    required: false,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            set: { type: 'object', nullable: true, description: 'An existing agent-set document to edit (seeds the builder).' },
            testResult: { type: 'object', nullable: true, description: 'A prior test run (transcript/functions/invocation log) to diagnose.' },
            // No `type`: a single definition object, or an array of them (one
            // per distinct agent on a transferred call) — typed loosely so the
            // request validator accepts both shapes.
            subjectAgent: { nullable: true, description: 'For a set-less troubleshoot: the diagnosed agent\'s own definition (prompt/functions/options) — or an array of definitions, one per distinct agent on the call — so fixes are grounded in what the agent actually says and does.' },
            knowledge: { type: 'string', nullable: true, description: 'A caller-formatted context block appended verbatim to the opening turn (e.g. website-knowledge state).' },
            model: { type: 'string', nullable: true, description: 'Per-session model override (a `text:` catalogue model the caller is allowed to use, e.g. from a user preference). 400 if unknown, 403 if not permitted.' },
            headless: { type: 'boolean', nullable: true, description: 'When true, SKIP the builder opening turn — the session waits for the caller\'s first user message instead of auto-running the build/edit/diagnose greeting. For headless callers (e.g. polite.ai\'s independent reviewer) that drive the agent programmatically over the socket.' },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Chat session created.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid', description: 'Chat session id' },
              socket: { type: 'string', description: 'Websocket path to open for the chat, e.g. /chat/<id>' },
            },
          },
        },
      },
    },
    default: {
      description: 'An error occurred',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    },
  },
};
