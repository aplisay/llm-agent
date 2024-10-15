const { Instance } = require('../../../../../lib/database');

let log;

module.exports = function (logger) {
  log = logger;
  return {
    DELETE: listenerDelete,
  };
};

const listenerDelete = async (req, res) => {
  let { instanceId } = req.params;
  req.log.info({ id: instanceId }, 'instance delete called');
  try {
    await Instance.destroy({
      where: {
        id: 'instanceId',
      },
    });
    res.status(200).send();
  }
  catch (err) {
    res.status(404).send(err);
    req.log.error(err, 'deleting instance');
  }

};

listenerDelete.apiDoc = {
  summary: 'Deletes a listener',
  operationId: 'deleteListener',
  tags: ["Agent"],
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

