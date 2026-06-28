import crypto from 'crypto';
import { runSubagentById, SubagentError } from '../../../lib/subagent.js';
import { recordSubagentUsage } from '../../../lib/usage.js';

let log;

const SUBAGENT_TIMEOUT = parseInt(process.env.SUBAGENT_TIMEOUT || '60000', 10);

export default function (logger) {
  log = logger;
  return {
    POST: subagentInvoke
  };
};

/**
 * Internal (shared-token) subagent invocation used by out-of-process workers:
 * a voice agent's `subagent` builtin function call lands here, the platform
 * runs the target text agent to completion, and the result is returned for
 * delivery back to the calling LLM as the function result.
 */
const subagentInvoke = async (req, res) => {
  const { agentId, input, metadata, organisationId, callId } = req.body || {};

  if (!agentId) {
    return res.status(400).send({ error: 'agentId is required' });
  }
  if (!organisationId) {
    // The caller's organisation is the tenancy boundary for which agents may be invoked
    return res.status(400).send({ error: 'organisationId is required' });
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SubagentError(`Subagent invocation timed out after ${SUBAGENT_TIMEOUT}ms`, 504)), SUBAGENT_TIMEOUT);
  });

  try {
    const { result, complete, usage } = await Promise.race([
      runSubagentById({ agentId, input, metadata, organisationId, logger: log.child({ callId, agentId }) }),
      timeout
    ]);
    log.info({ agentId, callId, complete }, 'subagent invocation complete');
    res.send({ result, complete });
    // Attribute the subagent's token usage to the originating call/session
    //  (best-effort; never blocks the response and never throws).
    recordSubagentUsage({
      sessionId: callId || crypto.randomUUID(),
      callId: callId || null,
      organisationId,
      usage,
      log,
    });
  }
  catch (err) {
    if (err instanceof SubagentError) {
      log.info({ agentId, callId, message: err.message }, 'subagent invocation failed');
      return res.status(err.status || 400).send({ error: err.message });
    }
    // Surface the real cause (this is an internal, shared-token endpoint called
    // by our own workers). A generic 500 here left the calling agent — and the
    // set builder — blind, mis-attributing subagent failures to the MCP server.
    log.error(err, 'error invoking subagent');
    res.status(500).send({ error: `Subagent invocation failed: ${err?.message || err}` });
  }
  finally {
    clearTimeout(timer);
  }
};

subagentInvoke.apiDoc = {
  summary: 'Internal: invokes a text agent as a subagent.',
  operationId: 'agentDbInvokeSubagent',
  tags: ["Agent"],
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              format: 'uuid',
              description: 'Target text agent'
            },
            input: {
              type: 'object',
              description: 'Generated parameters forwarded from the calling function',
              additionalProperties: true
            },
            metadata: {
              type: 'object',
              description: 'Call metadata made available to the subagent\'s own functions',
              additionalProperties: true
            },
            organisationId: {
              type: 'string',
              description: 'Organisation of the calling agent; the target must belong to it'
            },
            callId: {
              type: 'string',
              description: 'Calling call ID, for log correlation'
            }
          },
          required: ['agentId', 'organisationId']
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Subagent result.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              result: {
                type: 'object',
                additionalProperties: true
              },
              complete: {
                type: 'boolean'
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
