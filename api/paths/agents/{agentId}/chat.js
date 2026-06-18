import { createChatSession } from '../../../../lib/text-chat.js';
import { resolveAgentForUser } from '../../../../lib/builtin-agents.js';

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
  try {
    const { agent } = await resolveAgentForUser(agentId, res.locals.user);
    if (!agent) {
      return res.status(404).send({ message: `Agent with ID ${agentId} not found` });
    }
    if ((agent.type || 'interactive-audio') !== 'text') {
      return res.status(400).send({
        message: `Agent ${agentId} is type ${agent.type || 'interactive-audio'}; only text agents support chat`,
      });
    }
    const session = createChatSession({ agent, logger: req.log });
    log.info({ agentId, sessionId: session.id }, 'agent chat session started');
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
