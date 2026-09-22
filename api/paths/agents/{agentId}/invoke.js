import crypto from 'crypto';
import { Agent, Call, Organisation } from '../../../../lib/database.js';
import { scopeWhereForUser } from '../../../../lib/scope.js';
import { runSubagent, SubagentError } from '../../../../lib/subagent.js';
import { recordSubagentUsage } from '../../../../lib/usage.js';
import { requirePermission, can, ORGANISATION_RBAC_ATTRIBUTES } from '../../../../lib/auth/permissions.js';
import { isModelAllowed, effectiveAllowedModels } from '../../../../lib/auth/model-access.js';

let log;

const SUBAGENT_TIMEOUT = parseInt(process.env.SUBAGENT_TIMEOUT || '60000', 10);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function (logger) {
  log = logger;
  return {
    POST: agentInvoke
  };
};

const agentInvoke = async (req, res) => {
  const { agentId } = req.params;
  const { input, metadata, callId, organisationId } = req.body || {};
  if (!requirePermission(res, 'agent', 'invoke')) return;
  const principal = res.locals.user;

  // Who the usage rows belong to: the principal's own organisation, or the
  // organisation an organisation-less service principal names in the body
  // (the polite-ai call-analysis seam, docs/call-hooks.md). On that path the
  // rows carry no user: the actor is not a member of the organisation.
  let attribution = { organisationId: principal?.organisationId || null, userId: principal?.id || null };
  let where = { id: agentId, ...scopeWhereForUser(principal) };
  let onBehalfOf = null;
  if (organisationId !== undefined && organisationId !== null) {
    if (principal?.organisationId) {
      return res.status(400).send({ message: 'organisationId is accepted only from a principal with no organisation of its own' });
    }
    if (!can(principal, 'agent', 'readAll')) {
      return res.status(403).send({ message: 'forbidden', detail: 'Requires agent:readAll to invoke on behalf of an organisation' });
    }
    if (!UUID_RE.test(String(organisationId))) {
      return res.status(400).send({ message: 'organisationId must be an organisation UUID' });
    }
    where = { id: agentId, organisationId };
    attribution = { organisationId, userId: null };
    onBehalfOf = organisationId;
  }
  if (callId !== undefined && callId !== null && !UUID_RE.test(String(callId))) {
    return res.status(400).send({ message: 'callId must be a call UUID' });
  }
  const recordUsage = (usage) => recordSubagentUsage({
    sessionId: crypto.randomUUID(),
    callId: callId || null,
    ...attribution,
    usage,
    finalised: true,
    log: req.log,
  });

  try {
    const agent = await Agent.findOne({ where });
    if (!agent) {
      return res.status(404).send({ message: `Agent with ID ${agentId} not found` });
    }
    if ((agent.type || 'interactive-audio') !== 'text') {
      return res.status(400).send({ message: `Agent ${agentId} is type ${agent.type}; only text agents can be invoked` });
    }
    // Recheck model access at invocation time so saved agents cannot bypass a tightened allow-list. See PR #153.
    if (!isModelAllowed(agent.modelName, principal?._allowedModels)) {
      return res.status(403).send({ message: 'model_not_permitted', detail: `Model ${agent.modelName} is not permitted for your account.` });
    }
    if (onBehalfOf) {
      // The organisation's own model floor, as runSubagentById applies it: no
      // member principal is present, so the organisation's list is the gate.
      const org = await Organisation.findByPk(onBehalfOf, { attributes: ORGANISATION_RBAC_ATTRIBUTES });
      const orgAllowed = effectiveAllowedModels(null, org);
      if (orgAllowed && !isModelAllowed(agent.modelName, orgAllowed)) {
        return res.status(403).send({ message: 'model_not_permitted', detail: `Model ${agent.modelName} is not permitted for this organisation.` });
      }
    }
    if (callId) {
      // The usage rows reference the call, so it must exist and be visible to
      // the organisation the rows are attributed to.
      const callWhere = onBehalfOf ? { id: callId, organisationId: onBehalfOf } : { id: callId, ...scopeWhereForUser(principal) };
      const call = await Call.findOne({ where: callWhere, attributes: ['id'] });
      if (!call) {
        return res.status(404).send({ message: `Call ${callId} not found` });
      }
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
      recordUsage(usage);
    } finally {
      clearTimeout(timer);
    }
  }
  catch (err) {
    // A failed invocation still billed the tokens of its completed turns —
    // runSubagent rides them on the error (best-effort; never throws).
    if (Array.isArray(err?.usage)) {
      recordUsage(err.usage);
    }
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
              description: 'Task input for the agent: an object (passed as the opening user message), or a string or array, '
                + 'which a generative agent receives as text and a decision model receives as its state',
              anyOf: [
                { type: 'object', additionalProperties: true },
                { type: 'string' },
                { type: 'array', items: {} },
              ],
            },
            metadata: {
              type: 'object',
              description: 'Metadata visible to the agent\'s own functions (source: "metadata" parameters)',
              additionalProperties: true
            },
            callId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'A call this invocation is about. Stamped on the invocation\'s usage rows, so the spend '
                + 'shows per call in `GET /usage?callId=`. The call must exist in the organisation the usage is '
                + 'attributed to (404 otherwise).'
            },
            organisationId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'Invoke on behalf of an organisation. Accepted only from a principal with no organisation '
                + 'of its own that holds `agent:readAll` (the `analysisService` role); the agent is looked up in that '
                + 'organisation, the organisation\'s model allow-list applies, and the usage rows are attributed to it '
                + 'with no user. A principal that belongs to an organisation gets a 400.'
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
