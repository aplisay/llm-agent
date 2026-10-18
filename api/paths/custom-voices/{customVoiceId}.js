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
    description: `Poll this after [\`POST /models/{modelName}/voices/{locale}\`](#operation-createModelVoice) until \`status\` is \`ready\` or \`failed\` (about 20 seconds for OpenAI). A failed voice carries \`error\` and \`errorCode\`. If a create has gone quiet for 90 seconds, this call looks for the voice at the vendor and settles it; after 3 minutes with no voice there it is marked failed with \`errorCode: interrupted\`.

Requires \`voice:read\`.`,
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
    description: `Deletes the voice at the vendor (OpenAI), then marks it deleted here: it leaves the voice lists, no agent can be saved with it, and it stops counting against the quota. If the vendor delete fails (502 or 503), nothing changes and the delete can be retried.

Refused with 409 (\`code: custom_voice_in_use\`, with \`agents\`) while an agent of the organisation still uses it. With \`force=true\` it is deleted anyway, and those agents speak with the model's default voice until their voice is changed.

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
      502: { description: 'The vendor could not delete the voice; it is unchanged', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, DELETE: del };
}
