import crypto from 'crypto';
import { Agent } from '../../../../lib/database.js';
import { scopeWhereForUser } from '../../../../lib/scope.js';
import { runSubagent, SubagentError } from '../../../../lib/subagent.js';
import { recordSubagentUsage } from '../../../../lib/usage.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';

let log;

const SUBAGENT_TIMEOUT = parseInt(process.env.SUBAGENT_TIMEOUT || '60000', 10);

export default function (logger) {
  log = logger;
  return {
    POST: agentInvoke
  };
};

const agentInvoke = async (req, res) => {
  const { agentId } = req.params;
  const { input, metadata } = req.body || {};
  if (!requirePermission(res, 'agent', 'invoke')) return;

  try {
    const agent = await Agent.findOne({ where: { id: agentId, ...scopeWhereForUser(res.locals.user) } });
    if (!agent) {
      return res.status(404).send({ message: `Agent with ID ${agentId} not found` });
    }
    if ((agent.type || 'interactive-audio') !== 'text') {
      return res.status(400).send({ message: `Agent ${agentId} is type ${agent.type}; only text agents can be invoked` });
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SubagentError(`Subagent invocation timed out after ${SUBAGENT_TIMEOUT}ms`, 504)), SUBAGENT_TIMEOUT);
    });
    try {
      const { result, complete, transcript, usage } = await Promise.race([
        runSubagent({ agent, input, metadata, logger: req.log }),
        timeout
      ]);
      res.send({ result, complete, transcript });
      // Record token usage for this one-shot invocation (best-effort; never
      //  blocks the response and never throws).
      recordSubagentUsage({
        sessionId: crypto.randomUUID(),
        organisationId: res.locals.user?.organisationId || null,
        userId: res.locals.user?.id || null,
        usage,
        finalised: true,
        log: req.log,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  catch (err) {
    if (err instanceof SubagentError) {
      return res.status(err.status || 400).send({ message: err.message });
    }
    req.log.error(err, 'invoking agent');
    res.status(500).send({ message: err.message });
  }
};

agentInvoke.apiDoc = {
  summary: 'Invokes a text agent and returns its result.',
  description: `Runs a \`text\` type agent headlessly: the request \`input\` object is presented to the
                agent as its task, the agent runs its own LLM/tool loop, and the call returns when the
                agent delivers its work product by calling its builtin \`result\` platform function.
                The same mechanism is used when a voice agent invokes a text agent through a
                \`subagent\` builtin function.`,
  operationId: 'invokeAgent',
  tags: ["Agent"],
  parameters: [
    {
      description: "ID of the (text) agent to invoke",
      in: 'path',
      name: 'agentId',
      required: true,
      schema: {
        type: 'string'
      }
    }
  ],
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            input: {
              type: 'object',
              description: 'Task input for the agent, passed as the opening user message',
              additionalProperties: true
            },
            metadata: {
              type: 'object',
              description: 'Metadata visible to the agent\'s own functions (source: "metadata" parameters)',
              additionalProperties: true
            }
          }
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Invocation result.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              result: {
                description: 'The arguments the agent passed to its result function (or `{text}` fallback)',
                type: 'object',
                additionalProperties: true
              },
              complete: {
                description: 'True when the agent terminated by calling its result function',
                type: 'boolean'
              },
              transcript: {
                description: 'The internal conversation turns of the invocation',
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: true
                }
              }
            }
          }
        }
      }
    },
    default: {
      description: 'An error occurred',
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/Error'
          }
        }
      }
    }
  }
};
