import { requirePermission } from '../../lib/auth/permissions.js';
import {
  CustomVoiceError,
  getCustomVoiceQuota,
  listCustomVoices,
} from '../../lib/custom-voices/index.js';

/**
 * GET /api/custom-voices: the caller's organisation's custom voices and its
 * quota (docs/custom-voices.md). Voices are created with
 * POST /models/{modelName}/voices/{locale}.
 */
export default function (logger) {
  const list = async (req, res) => {
    if (!requirePermission(res, 'voice', 'read')) return;
    const user = res.locals.user;
    try {
      const includeDeleted = req.query?.includeDeleted === true || req.query?.includeDeleted === 'true';
      const modelName = req.query?.modelName ? String(req.query.modelName) : undefined;
      const [voices, quota] = await Promise.all([
        listCustomVoices(user, { includeDeleted, modelName }),
        getCustomVoiceQuota(user),
      ]);
      res.send({ voices, quota });
    } catch (err) {
      if (err instanceof CustomVoiceError) {
        return res.status(err.statusCode).send({ message: err.message, ...err.extra });
      }
      req.log.error({ err }, 'listing custom voices');
      res.status(500).send({ message: 'Failed to list custom voices' });
    }
  };

  list.apiDoc = {
    summary: 'List the organisation\'s custom voices and quota',
    description: `Returns the custom voices that belong to the caller's organisation, newest first, and the organisation's quota. Create a voice with [\`POST /models/{modelName}/voices/{locale}\`](#operation-createModelVoice) (\`docs/custom-voices.md\`).

\`quota.used\` counts voices that are being created or are ready, plus deleted voices the vendor still holds. OpenAI has no call to delete a voice, so a deleted OpenAI voice still counts.

Requires \`voice:read\`.`,
    operationId: 'listCustomVoices',
    tags: ['Voices'],
    parameters: [
      {
        in: 'query',
        name: 'includeDeleted',
        required: false,
        schema: { type: 'boolean', default: false },
        description: 'Also return deleted voices.',
      },
      {
        in: 'query',
        name: 'modelName',
        required: false,
        schema: { type: 'string' },
        description: 'Only voices this model can speak, e.g. `pipecat:openai/gpt-live-1`.',
      },
    ],
    responses: {
      200: {
        description: 'Voices and quota',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                voices: { type: 'array', items: { $ref: '#/components/schemas/CustomVoice' } },
                quota: { $ref: '#/components/schemas/CustomVoiceQuota' },
              },
              required: ['voices', 'quota'],
            },
          },
        },
      },
      403: { description: 'Lacks `voice:read`', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: list };
}
