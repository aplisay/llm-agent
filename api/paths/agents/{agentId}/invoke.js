import crypto from 'crypto';
import { Agent, Call, Organisation } from '../../../../lib/database.js';
import { scopeWhereForUser } from '../../../../lib/scope.js';
import { runSubagent, organisationAllowsModel, SubagentError } from '../../../../lib/subagent.js';
import { recordSubagentUsage } from '../../../../lib/usage.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { isModelAllowed } from '../../../../lib/auth/model-access.js';

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

  // The tenant the usage is charged to: the principal's own organisation, or the one an
  // organisation-less service principal names in the body (docs/call-hooks.md).
  if (organisationId !== undefined && organisationId !== null) {
    if (principal?.organisationId) {
      return res.status(400).send({ message: 'organisationId is accepted only from a principal with no organisation of its own' });
    }
    if (!requirePermission(res, 'agent', 'readAll')) return;
    if (!UUID_RE.test(String(organisationId))) {
      return res.status(400).send({ message: 'organisationId must be an organisation UUID' });
    }
  }
  if (callId !== undefined && callId !== null && !UUID_RE.test(String(callId))) {
    return res.status(400).send({ message: 'callId must be a call UUID' });
  }
  const onBehalf = organisationId !== undefined && organisationId !== null;
  const scope = onBehalf ? { organisationId } : scopeWhereForUser(principal);
  const attribution = onBehalf
    ? { organisationId, userId: null }
    : { organisationId: principal?.organisationId || null, userId: principal?.id || null };
  const recordUsage = (usage) => recordSubagentUsage({
    sessionId: crypto.randomUUID(),
    callId: callId || null,
    ...attribution,
    usage,
    finalised: true,
    // Priced when it runs: a cited call must not pull the rows onto that call's older rate card.
    billedAt: callId ? new Date() : null,
    log: req.log,
  });

  try {
    const agent = await Agent.findOne({ where: { id: agentId, ...scope } });
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
    if (onBehalf) {
      // No member principal carries the organisation's state here, so apply what the account gate
      // and Call.start would: an inactive or billing-blocked organisation runs nothing.
      const org = await Organisation.findByPk(organisationId, { attributes: ['id', 'status', 'billingBlocked'] });
      if (!org || org.status !== 'active') {
        return res.status(403).send({ message: 'organisation_inactive', detail: 'The organisation is not active.' });
      }
      if (org.billingBlocked) {
        return res.status(403).send({ message: 'billing_blocked', detail: 'Billing is blocked for the organisation.' });
      }
      if (!(await organisationAllowsModel(agent))) {
        return res.status(403).send({ message: 'model_not_permitted', detail: `Model ${agent.modelName} is not permitted for this organisation.` });
      }
    }
    if (callId) {
      // The usage rows reference the call, so it must exist in the tenant they are charged to
      // (the organisation, or the user when the principal has none).
      const callScope = attribution.organisationId ? { organisationId: attribution.organisationId } : { userId: attribution.userId };
      const call = await Call.findOne({ where: { id: callId, ...callScope }, attributes: ['id'] });
      if (!call) {
        return res.status(404).send({ message: `Call ${callId} not found` });
      }
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SubagentError(`Subagent invocation timed out after ${SUBAGENT_TIMEOUT}ms`, 504)), SUBAGENT_TIMEOUT);
    });
    // The run is metered when it settles, whichever way the race goes: a run that
    // outlives the timeout still spends tokens, and they are recorded when it ends.
    const run = runSubagent({ agent, input, metadata, logger: req.log });
    run.then(
      ({ usage }) => recordUsage(usage),
      (err) => { if (Array.isArray(err?.usage)) recordUsage(err.usage); },
    );
    try {
      const { result, complete, transcript } = await Promise.race([run, timeout]);
      res.send({ result, complete, transcript });
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
                + 'charged to (404 otherwise). The rows are priced when the invocation runs, not at the call\'s start.'
            },
            organisationId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'Invoke on behalf of an organisation. Accepted only from a principal with no organisation '
                + 'of its own that holds `agent:readAll` (the `analysisService` role, whose model list allows decision '
                + 'models only); the agent is looked up in that organisation, which must be active and not billing '
                + 'blocked, the organisation\'s model allow-list applies, and the usage rows are attributed to it with '
                + 'no user. A principal that belongs to an organisation gets a 400.'
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
