import { Instance } from '../../../lib/database.js';
import { scopeWhereForUser } from '../../../lib/scope.js';

let log;

export default function (logger) {
  log = logger;
  return {
    DELETE: listenerDelete,
  };
};

const listenerDelete = async (req, res) => {
  const { listenerId } = req.params;
  req.log.info({ id: listenerId }, 'instance delete called');

  try {
    const deleted = await Instance.destroy({
      where: {
        id: listenerId,
        ...scopeWhereForUser(res.locals.user),
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
  operationId: 'deleteListenerById',
  tags: ["Listeners"],
  parameters: [
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
      description: 'Deleted Listener.',
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


