import { Agent, Instance, PhoneNumber } from '../../../../lib/database.js';
import { scopeWhereForUser } from '../../../../lib/scope.js';

/**
 * Room key + id for embedding @aplisay/react-widget (see https://widget.aplisay.com).
 */
export default function (logger) {
  return {
    GET: roomKeyGet,
  };
}

const roomKeyGet = async (req, res) => {
  const { listenerId } = req.params;
  const agentScope = scopeWhereForUser(res.locals.user);

  try {
    const instance = await Instance.findOne({
      where: { id: listenerId },
      include: [
        {
          model: Agent,
          where: agentScope,
          required: true,
        },
        {
          model: PhoneNumber,
          as: 'number',
          required: false,
          attributes: ['number'],
        },
      ],
    });

    if (!instance) {
      return res.status(404).send({ error: 'Listener not found' });
    }

    if (instance.number?.number) {
      return res.status(400).send({
        error: 'Room key applies to WebRTC listeners only, not phone listeners.',
      });
    }

    if (!instance.key) {
      return res.status(404).send({ error: 'No room key for this listener' });
    }

    res.send({
      listenerId: instance.id,
      roomKey: instance.key,
    });
  } catch (err) {
    req.log.error(err, 'room-key');
    res.status(500).send(err.message || String(err));
  }
};

roomKeyGet.apiDoc = {
  summary: 'Room key and listener id for the Aplisay embeddable widget (@aplisay/react-widget)',
  description:
    'Returns `listenerId` and `roomKey` for WebRTC-only listeners. Use with the widget configurator at https://widget.aplisay.com .',
  operationId: 'getListenerRoomKey',
  tags: ['Listeners'],
  parameters: [
    {
      in: 'path',
      name: 'listenerId',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    },
  ],
  responses: {
    200: {
      description: 'Credentials for AplisayWidget props',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              listenerId: { type: 'string', format: 'uuid' },
              roomKey: { type: 'string', description: 'Pass as roomKey to AplisayWidget' },
            },
          },
        },
      },
    },
    400: { description: 'Listener is telephony / has a number' },
    404: { description: 'Not found or no key' },
  },
};
