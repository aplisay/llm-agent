import { requirePermission } from '../../../lib/auth/permissions.js';
import {
  CustomVoiceError,
  deleteCustomVoice,
  getCustomVoice,
} from '../../../lib/custom-voices/index.js';

/**
 * GET / DELETE /api/custom-voices/{customVoiceId} (docs/custom-voices.md).
 * Another organisation's voice is a 404, so its existence is not leaked.
 */
export default function (logger) {
  const sendError = (req, res, err, what) => {
    if (err instanceof CustomVoiceError) {
      return res.status(err.statusCode).send({ message: err.message, ...err.extra });
    }
    req.log.error({ err, customVoiceId: req.params.customVoiceId }, what);
    return res.status(500).send({ message: `Failed to ${what}` });
  };

  const get = async (req, res) => {
    if (!requirePermission(res, 'voice', 'read')) return;
    try {
      res.send(await getCustomVoice(res.locals.user, req.params.customVoiceId));
    } catch (err) {
      sendError(req, res, err, 'read the custom voice');
    }
  };

  get.apiDoc = {
    summary: 'Get one of the organisation\'s custom voices',
    operationId: 'getCustomVoice',
    tags: ['Voices'],
    parameters: [{ in: 'path', name: 'customVoiceId', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'The voice', content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomVoice' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const del = async (req, res) => {
    if (!requirePermission(res, 'voice', 'delete')) return;
    try {
      const force = req.query?.force === true || req.query?.force === 'true';
      const voice = await deleteCustomVoice(res.locals.user, req.params.customVoiceId, { force });
      req.log.info({ customVoiceId: voice.id, vendor: voice.vendor, force }, 'custom voice deleted');
      res.send(voice);
    } catch (err) {
      sendError(req, res, err, 'delete the custom voice');
    }
  };

  del.apiDoc = {
    summary: 'Delete one of the organisation\'s custom voices',
    description: `Marks the voice deleted: it leaves the voice lists and no agent can be saved with it.

Refused with 409 (\`code: custom_voice_in_use\`, with \`agents\`) while an agent of the organisation still uses it. With \`force=true\` it is deleted anyway, and those agents speak with the model's default voice until their voice is changed.

OpenAI has no call to delete a voice. A deleted OpenAI voice stays in the platform's OpenAI organisation and still counts against the quota.

Requires \`voice:delete\`.`,
    operationId: 'deleteCustomVoice',
    tags: ['Voices'],
    parameters: [
      { in: 'path', name: 'customVoiceId', required: true, schema: { type: 'string', format: 'uuid' } },
      {
        in: 'query',
        name: 'force',
        required: false,
        schema: { type: 'boolean', default: false },
        description: 'Delete even when agents use the voice.',
      },
    ],
    responses: {
      200: { description: 'The deleted voice', content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomVoice' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      409: { description: 'In use by agents, or still being created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, DELETE: del };
}
