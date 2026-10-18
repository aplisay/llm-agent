import {
  getModelVoicesForLocale,
} from '../../../../../lib/model-voices.js';
import { can, requirePermission } from '../../../../../lib/auth/permissions.js';
import { isModelAllowed } from '../../../../../lib/auth/model-access.js';
import {
  createCustomVoice,
  customVoiceCatalogueRows,
  CustomVoiceError,
} from '../../../../../lib/custom-voices/index.js';

export default function (logger, voices) {
  const modelVoicesByLocaleGet = async (req, res) => {
    try {
      const modelName = decodeParam(req.params.modelName);
      const locale = decodeParam(req.params.locale);
      const body = await getModelVoicesForLocale({
        modelName,
        locale,
        voicesInstance: voices,
      });
      const user = res.locals?.user;
      if (user && can(user, 'voice', 'read')) {
        // The organisation's own voices come first, under the vendor key the model uses.
        const custom = await customVoiceCatalogueRows(user, modelName, { locale });
        for (const [vendor, rows] of Object.entries(custom)) {
          body.vendors[vendor] = [...rows, ...(body.vendors[vendor] || [])];
        }
      }
      res.send(body);
    } catch (err) {
      const code = err.statusCode || 500;
      req.log.error(
        { err, modelName: req.params.modelName, locale: req.params.locale },
        'model voices by locale',
      );
      res.status(code).send({ error: err.message || String(err) });
    }
  };

  modelVoicesByLocaleGet.apiDoc = {
    summary: 'List TTS voices by vendor for a model and locale',
    description: `Returns a vendor-keyed map of voice rows for the given \`locale\` (from [\`GET /models/{modelName}/voices\`](#operation-modelVoiceLocales)).

For **LiveKit realtime** models, vendors are limited to the model’s provider (OpenAI vs Ultravox, etc.), not the full merged catalogue.

The caller's organisation's own **custom voices** for this model come first in their vendor's list, marked \`custom: true\` with a \`customVoiceId\` (see [\`POST\`](#operation-createModelVoice) on this path). A custom voice is listed at its own locale. One made at \`any\` is listed at every locale, and asking for \`any\` lists them all.

Encode both \`modelName\` and \`locale\` if they contain reserved characters.`,
    operationId: 'modelVoicesByLocale',
    tags: ['Models'],
    parameters: [
      {
        in: 'path',
        name: 'modelName',
        required: true,
        schema: { type: 'string' },
        example: 'livekit%3Aopenai%2Fgpt-4o',
      },
      {
        in: 'path',
        name: 'locale',
        required: true,
        schema: { type: 'string' },
        example: 'en-GB',
      },
    ],
    responses: {
      200: {
        description: 'Vendor → voice list',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                vendors: {
                  type: 'object',
                  additionalProperties: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Voice' },
                  },
                },
                voiceStack: {
                  type: 'string',
                  enum: ['realtime', 'pipeline'],
                },
              },
              required: ['vendors'],
            },
          },
        },
      },
      default: {
        description: 'Error',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
          },
        },
      },
    },
  };

  const modelVoiceCreate = async (req, res) => {
    if (!requirePermission(res, 'voice', 'create')) return;
    const modelName = decodeParam(req.params.modelName);
    const locale = decodeParam(req.params.locale);
    const user = res.locals.user;
    if (!isModelAllowed(modelName, user?._allowedModels)) {
      return res.status(403).json({ message: 'model_not_permitted', detail: `Model ${modelName} is not permitted for your account.` });
    }
    try {
      const voice = await createCustomVoice({ user, modelName, locale, body: req.body || {}, log: req.log });
      req.log.info({ customVoiceId: voice.id, vendor: voice.vendor, modelName, locale }, 'custom voice create started');
      res.set('Location', `/api/custom-voices/${voice.id}`);
      res.status(202).send(voice);
    } catch (err) {
      if (err instanceof CustomVoiceError) {
        req.log.warn({ err: err.message, modelName, locale, code: err.extra?.code }, 'custom voice not created');
        return res.status(err.statusCode).send({ message: err.message, ...err.extra });
      }
      req.log.error({ err, modelName, locale }, 'custom voice create');
      res.status(500).send({ message: 'Failed to create the custom voice' });
    }
  };

  modelVoiceCreate.apiDoc = {
    summary: 'Create a custom voice for a model',
    description: `Creates a voice that belongs to the caller's organisation and can be used on this model (\`docs/custom-voices.md\`). Only that organisation can list it or use it.

The first and only method is \`prompt\`: describe the voice in plain language and the vendor generates it. The vendor is the model's own: OpenAI for GPT-Live (\`pipecat:openai/gpt-live-1\`). OpenAI prompt voices work on GPT-Live only.

The call checks the request, takes a quota slot and returns **202** at once with the voice in \`status: "creating"\` and a \`Location\` header. The vendor then makes the voice in the background (about 20 seconds for OpenAI). Poll [\`GET /custom-voices/{customVoiceId}\`](#operation-getCustomVoice) every few seconds until \`status\` is \`ready\` or \`failed\`. When it is ready, put its \`voice\` value in an agent's \`options.tts.voice\`; \`GET\` on this path then lists it under its vendor at \`locale\`, or at every locale when \`locale\` is \`any\`.

A vendor refusal (for example a prompt that names a real person) or a vendor failure arrives on the voice: \`status: "failed"\`, with \`error\` and \`errorCode\` (\`rejected\`: change the input; \`vendor_unavailable\` or \`vendor_error\`: try again; \`interrupted\`: the server lost the create). A failed voice does not count against the quota.

Each organisation has a quota (\`customVoiceLimit\` on the organisation, default 3). Deleting a voice frees its slot. Read the quota with [\`GET /custom-voices\`](#operation-listCustomVoices).

Requires \`voice:create\`.`,
    operationId: 'createModelVoice',
    tags: ['Models', 'Voices'],
    parameters: [
      {
        in: 'path',
        name: 'modelName',
        required: true,
        description: 'Full model id; URL-encode reserved characters (`:`, `/`).',
        schema: { type: 'string' },
        example: 'pipecat%3Aopenai%2Fgpt-live-1',
      },
      {
        in: 'path',
        name: 'locale',
        required: true,
        description: 'Where the voice is listed: a BCP 47 tag such as `en-GB`, or `any`.',
        schema: { type: 'string' },
        example: 'en-GB',
      },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CustomVoiceCreateInput' },
          example: {
            name: 'Brighton concierge',
            prompt: 'A warm, unhurried woman in her forties with a soft southern English accent, mid-low pitch, clear and friendly, at a relaxed pace.',
            gender: 'female',
          },
        },
      },
    },
    responses: {
      202: {
        description: 'Accepted: the voice, in status `creating`. `Location` names it under `/custom-voices`.',
        headers: { Location: { schema: { type: 'string' }, description: 'The voice to poll' } },
        content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomVoice' } } },
      },
      400: {
        description: 'Invalid input, or a model with no custom voices',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      403: {
        description: 'Lacks `voice:create`, or the model is not permitted',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      409: {
        description: 'The organisation\'s quota is used up (`code: custom_voice_quota_exceeded`, with `quota`)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomVoiceQuotaError' } } },
      },
      501: {
        description: '`method: "recording"` is not available yet',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      503: {
        description: 'The vendor is not configured, or the platform has no slots left',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      default: {
        description: 'Error',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  };

  return {
    GET: modelVoicesByLocaleGet,
    POST: modelVoiceCreate,
  };
}

function decodeParam(raw) {
  if (raw == null) return '';
  try {
    return decodeURIComponent(String(raw));
  } catch {
    return String(raw);
  }
}
