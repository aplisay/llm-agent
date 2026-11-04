import { requirePermission } from '../../../../lib/auth/permissions.js';
import {
  CustomVoiceError,
  deleteCustomVoice,
  getCustomVoice,
  patchCustomVoice,
} from '../../../../lib/custom-voices/index.js';

/**
 * GET / PATCH / DELETE /api/voices/custom/{customVoiceId} (docs/custom-voices.md).
 * Another organisation's own voice is a 404, so its existence is not leaked.
 * PATCH changes a voice's description; withdraw and release are for platform voices only.
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
    summary: 'Get one of the organisation\'s custom voices, or a platform voice',
    description: `Poll this after [\`POST /models/{modelName}/voices/{locale}\`](#operation-createModelVoice) until \`status\` is \`ready\` or \`failed\` (about 20 seconds for OpenAI). A failed voice carries \`error\` and \`errorCode\`. If a create has gone quiet for 90 seconds, this call looks for the voice at the vendor and settles it; after 3 minutes with no voice there it is marked failed with \`errorCode: interrupted\`.

A platform voice (\`visibility: platform\`) can be read by every organisation.

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

  const patch = async (req, res) => {
    if (!requirePermission(res, 'voice', 'create')) return;
    try {
      const voice = await patchCustomVoice(res.locals.user, req.params.customVoiceId, req.body || {});
      req.log.info({ customVoiceId: voice.id, fields: Object.keys(req.body || {}) }, 'custom voice changed');
      res.send(voice);
    } catch (err) {
      sendError(req, res, err, 'change the custom voice');
    }
  };

  patch.apiDoc = {
    summary: 'Change a custom voice\'s description, or withdraw, restore or release a platform voice',
    description: `\`{ "description": "..." }\` sets the voice's description: words that help people and the agent builder find it, such as accent, region or style (for example "British, UK, English, Northern, Manchester"). It is searched and shown in voice lists, ahead of the prompt. It does not change how the voice sounds. \`null\` or a blank string clears it. It can be changed on the organisation's own voices, and on platform voices by a caller with \`voice:managePlatform\`.

These change a platform voice (\`visibility: platform\`) only, and are a 400 on an organisation's own voice:

- \`{ "withdrawn": true }\` withdraws the voice: it leaves every voice list, and no agent can newly take it. Agents that already have it keep speaking with it, and can still be saved with it, until their voice is changed. \`{ "withdrawn": false }\` lists it again.
- \`{ "release": { "to": "<url>" } }\` records that the vendor voice is now managed at \`to\`, another platform whose vendor key can use the same voice. A later delete here then only marks the voice deleted, and does not delete it at the vendor. A release cannot be undone, and a second one changes nothing. The voice must be \`ready\`.

Any other field is a 400: there is no rename.

Requires \`voice:create\`, and \`voice:managePlatform\` for a platform voice.`,
    operationId: 'patchCustomVoice',
    tags: ['Voices'],
    parameters: [{ in: 'path', name: 'customVoiceId', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CustomVoicePatch' },
          example: { description: 'British, UK, English, Northern, Manchester' },
        },
      },
    },
    responses: {
      200: { description: 'The voice', content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomVoice' } } } },
      400: { description: 'Invalid body, or a platform-only change to an organisation voice', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Lacks `voice:create`, or `voice:managePlatform` for a platform voice', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      409: { description: 'A release of a voice that is not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
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

A platform voice (\`visibility: platform\`) also needs \`voice:managePlatform\`, and is refused with 409 while any agent in any organisation uses it, whatever \`force\` says. The 409 then lists up to 50 agents with \`organisationId\` and \`organisationName\`, and \`total\`. Withdraw the voice with [\`PATCH\`](#operation-patchCustomVoice) so no new agent takes it. A released platform voice is marked deleted here without a vendor delete.

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
        description: 'Delete even when agents use the voice. Ignored for a platform voice.',
      },
    ],
    responses: {
      200: { description: 'The deleted voice', content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomVoice' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      403: { description: 'Lacks `voice:delete`, or `voice:managePlatform` for a platform voice', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'In use by agents (`code: custom_voice_in_use`), or still being created', content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomVoiceInUseError' } } } },
      502: { description: 'The vendor could not delete the voice; it is unchanged', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PATCH: patch, DELETE: del };
}
