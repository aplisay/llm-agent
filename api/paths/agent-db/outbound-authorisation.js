import { Agent, PhoneNumber } from '../../../lib/database.js';
import { authoriseOutboundDestination } from '../../../lib/outbound-authorisation.js';
import { normalizeE164 } from '../../../lib/validation.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    POST: authoriseOutbound
  };
};

/**
 * Internal (x-shared-token) authorisation of one outbound destination, for the
 * workers. The policy itself lives in lib/outbound-authorisation.js because only
 * the API server can see `Trunk`, `RateCard` and `Tariff`; a worker must never
 * re-implement it, and must fail CLOSED when this endpoint is unreachable.
 *
 * `agentId` is preferred over an inline `agentOptions`: the agent's filter is then
 * read from the database rather than trusted from the caller. `agentOptions` is
 * accepted for the in-call case where the worker already holds a resolved (possibly
 * listener-overridden) agent definition.
 *
 * Always 200 with `{ allowed }` for a decided request — a refusal is a decision,
 * not a transport error — so callers distinguish "denied" from "could not decide".
 */
const authoriseOutbound = (async (req, res) => {
  const {
    calledId,
    callerId,
    agentId,
    agentOptions,
    organisationId,
    userId,
    aplisayId,
    outboundTrunkId,
    registrationOriginated,
  } = req.body || {};

  try {
    if (!calledId || typeof calledId !== 'string') {
      return res.status(400).send({ error: 'calledId is required' });
    }

    let options = agentOptions && typeof agentOptions === 'object' ? agentOptions : null;
    let owner = { organisationId, userId };
    if (agentId) {
      const agent = await Agent.findByPk(agentId, {
        attributes: ['id', 'options', 'userId', 'organisationId'],
      });
      if (!agent) {
        return res.status(404).send({ error: `Agent ${agentId} not found` });
      }
      // The stored options win over anything the caller asserted: the filter is
      // part of the tenant's configuration, not a per-request parameter.
      options = agent.options || null;
      owner = {
        organisationId: organisationId || agent.organisationId,
        userId: userId || agent.userId,
      };
    }

    // A worker that knows only the caller-ID (a WebRTC-origin transfer resolves its
    // egress from it) gets the trunk resolved here, so the chargeable-trunk policy
    // does not silently fall back to the platform default trunk.
    let egressAplisayId = aplisayId || null;
    if (!egressAplisayId && callerId && registrationOriginated !== true) {
      const caller = await PhoneNumber.findByPk(normalizeE164(callerId), { attributes: ['aplisayId'] });
      egressAplisayId = caller?.aplisayId || null;
    }

    const decision = await authoriseOutboundDestination({
      calledId,
      agentOptions: options,
      organisationId: owner.organisationId,
      userId: owner.userId,
      aplisayId: egressAplisayId,
      outboundTrunkId,
      registrationOriginated: registrationOriginated === true,
    });

    if (!decision.allowed) {
      log.info(
        { calledId, agentId, organisationId: owner.organisationId, code: decision.code, trunkId: decision.trunkId },
        'outbound destination refused',
      );
    }
    res.send(decision);
  } catch (err) {
    log.error(err, 'error authorising outbound destination');
    res.status(500).send({ error: 'Internal server error' });
  }
});

authoriseOutbound.apiDoc = {
  summary: 'Authorise an outbound destination against the agent, trunk and rating policy (internal).',
  operationId: 'authoriseOutboundDestination',
  tags: ['agent-db'],
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            calledId: { type: 'string', description: 'The destination as dialled' },
            callerId: {
              type: 'string',
              description: "Caller-ID for the leg. Used to resolve the egress trunk when aplisayId isn't known (e.g. a WebRTC-origin transfer). Ignored when registrationOriginated is true.",
            },
            agentId: {
              type: 'string',
              description: 'Agent whose stored options.outboundCallFilter applies. Preferred over agentOptions.',
            },
            agentOptions: {
              type: 'object',
              description: 'Resolved agent options when the caller already holds them (reads outboundCallFilter). Ignored when agentId is supplied.',
            },
            organisationId: { type: 'string', description: 'Owning organisation, for the rating check' },
            userId: { type: 'string', description: 'Owning user, for a per-user rate override' },
            aplisayId: { type: 'string', description: "The caller number's trunk id" },
            outboundTrunkId: { type: 'string', description: 'Explicit egress trunk id when the caller knows it' },
            registrationOriginated: {
              type: 'boolean',
              description: 'True when the leg egresses a customer B2BUA (never our carrier, so never chargeable)',
            },
          },
          required: ['calledId'],
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Authorisation decision.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              allowed: { type: 'boolean' },
              code: {
                type: 'string',
                enum: ['ok', 'agent_filter', 'default_filter', 'trunk_filter', 'not_rateable', 'invalid_destination'],
              },
              reason: { type: 'string', nullable: true },
              chargeable: { type: 'boolean', description: 'Whether the leg egresses one of our carrier trunks' },
              trunkId: { type: 'string', nullable: true },
              destination: { type: 'string', nullable: true, description: 'Canonical +E.164 form' },
              tariff: { type: 'string' },
              prefix: { type: 'string' },
            },
          },
        },
      },
    },
    400: {
      description: 'Bad request',
      content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } },
    },
    404: {
      description: 'Agent not found',
      content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } },
    },
  },
};
