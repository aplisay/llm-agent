import { Agent, Instance, PhoneNumber, PhoneRegistration, Op } from '../../lib/database.js';

/**
 * Flat list of active listener instances with parent agent name, for dashboards.
 */
export default function (logger) {
  return {
    GET: listenerDeploymentsList,
  };
}

const listenerDeploymentsList = async (req, res) => {
  const { id: userId, organisationId } = res.locals.user;
  const scopeWhere = organisationId
    ? { [Op.or]: [{ userId }, { organisationId }] }
    : { userId };

  const filterAgentId = req.query.agentId;
  const agentWhere = filterAgentId
    ? { [Op.and]: [scopeWhere, { id: filterAgentId }] }
    : scopeWhere;

  try {
    const agents = await Agent.findAll({
      where: agentWhere,
      attributes: ['id', 'name'],
      include: [
        {
          model: Instance,
          as: 'listeners',
          required: true,
          include: [
            {
              model: PhoneNumber,
              as: 'number',
              required: false,
              attributes: ['number'],
            },
            {
              model: PhoneRegistration,
              as: 'registration',
              required: false,
              attributes: ['id', 'name'],
            },
          ],
        },
      ],
      order: [['name', 'ASC']],
    });

    const items = [];
    for (const agent of agents) {
      const agentName = agent.name || 'Unnamed';
      for (const l of agent.listeners || []) {
        const phone = l.number?.number;
        const registrationId = l.registration?.id;
        const registrationName = l.registration?.name || null;
        const createdAt = l.createdAt ? new Date(l.createdAt).toISOString() : null;

        let kind = 'webrtc';
        if (phone) {
          kind = 'phone';
        } else if (registrationId) {
          kind = 'registration';
        }

        items.push({
          agentId: agent.id,
          agentName,
          listenerId: l.id,
          type: l.type,
          kind,
          phoneNumber: phone || null,
          registrationId: registrationId || null,
          registrationName,
          createdAt,
        });
      }
    }

    res.send({ items });
  } catch (err) {
    req.log.error(err, 'listener deployments list');
    res.status(500).send(err.message || String(err));
  }
};

listenerDeploymentsList.apiDoc = {
  summary: 'List active listener instances (deployments) for the current user’s agents',
  operationId: 'listListenerDeployments',
  tags: ['Listeners'],
  parameters: [
    {
      in: 'query',
      name: 'agentId',
      required: false,
      schema: { type: 'string', format: 'uuid' },
      description: 'If set, only return listeners for this agent (must belong to the requester).',
    },
  ],
  responses: {
    200: {
      description: 'Deployments with agent name and listener details',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    agentId: { type: 'string', format: 'uuid' },
                    agentName: { type: 'string' },
                    listenerId: { type: 'string', format: 'uuid' },
                    type: { type: 'string', enum: ['jambonz', 'ultravox', 'livekit'] },
                    kind: { type: 'string', enum: ['phone', 'registration', 'webrtc'] },
                    phoneNumber: { type: 'string', nullable: true },
                    registrationId: { type: 'string', nullable: true },
                    registrationName: { type: 'string', nullable: true },
                    createdAt: {
                      type: 'string',
                      format: 'date-time',
                      nullable: true,
                      description: 'When the listener (deployment) was created',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    default: {
      description: 'An error occurred',
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/Error',
          },
        },
      },
    },
  },
};

