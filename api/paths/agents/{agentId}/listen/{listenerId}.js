import { Instance, Op } from '../../../../../lib/database.js';

let log;

export default function (logger) {
  log = logger;
  return {
    DELETE: listenerDelete,
  };
};

const listenerDelete = async (req, res) => {
  const { listenerId } = req.params;
  const { id: userId, organisationId } = res.locals.user;
  req.log.info({ id: listenerId }, 'instance delete called');

  const scopeWhere = organisationId
    ? { [Op.or]: [{ userId }, { organisationId }] }
    : { userId };

  try {
    const deleted = await Instance.destroy({
      where: {
        id: listenerId,
        ...scopeWhere,
      },
    });

    if (!deleted) {
      return res.status(404).send({ error: `Listener with ID ${listenerId} not found` });
    }

    res.status(200).send();
  }
  catch (err) {
    req.log.error(err, 'deleting instance');
    res.status(404).send(err);
  }
};

listenerDelete.apiDoc = {
  summary: 'Deletes a listener',
  operationId: 'deleteListener',
  deprecated: true,
  tags: ["Listeners"],
  parameters: [
    {
      description: "Agent ID of the listener to delete",
      in: 'path',
      name: 'agentId',
      required: true,
      schema: {
        type: 'string'
      }
    },
    {
      description: "ID of the listener to delete",
      in: 'path',
      name: 'listenerId',
      required: true,
      schema: {
        type: 'string'
      }
    }
  ],
  responses: {
    200: {
      description: 'Deleted Listener. Deprecated - use DELETE /listener/{listenerId}',
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

