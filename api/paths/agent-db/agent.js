import { Agent } from '../../../lib/database.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: agentGet
  };
};

/**
 * Internal (shared-token) agent fetch used by workers, e.g. to load the target
 * agent definition for an in-call transfer_agent handover. Unlike the public
 * GET /agents/{agentId}, this returns the full row (including keys, which the
 * worker needs to execute the agent's functions) and is unscoped — callers
 * must enforce tenancy via the expectedOrganisationId parameter.
 */
const agentGet = async (req, res) => {
  const { agentId, expectedOrganisationId } = req.query;

  if (!agentId) {
    return res.status(400).send({ error: 'agentId query parameter is required' });
  }

  try {
    const agent = await Agent.findByPk(agentId);
    if (!agent) {
      return res.status(404).send({ error: 'Agent not found' });
    }
    // Tenancy guard: a worker acting for a call must only be able to load
    // agents belonging to the same organisation as that call's agent.
    if (expectedOrganisationId && agent.organisationId !== expectedOrganisationId) {
      log.warn({ agentId, expectedOrganisationId, actual: agent.organisationId }, 'cross-organisation agent fetch refused');
      return res.status(404).send({ error: 'Agent not found' });
    }
    res.send(agent.toJSON());
  }
  catch (err) {
    log.error(err, 'error fetching agent');
    res.status(500).send({ error: 'Internal server error' });
  }
};

agentGet.apiDoc = {
  summary: 'Internal: returns a full agent definition by ID.',
  operationId: 'agentDbGetAgent',
  tags: ["Agent"],
  parameters: [
    {
      in: 'query',
      name: 'agentId',
      required: true,
      schema: { type: 'string', format: 'uuid' },
      description: 'Agent ID to fetch'
    },
    {
      in: 'query',
      name: 'expectedOrganisationId',
      required: false,
      schema: { type: 'string' },
      description: 'When set, the fetch fails (404) unless the agent belongs to this organisation'
    }
  ],
  responses: {
    200: {
      description: 'Full agent definition (internal use only: includes keys).',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: true
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
