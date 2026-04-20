import {
  getModelVoicesForLocale,
} from '../../../../../lib/model-voices.js';

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

  return {
    GET: modelVoicesByLocaleGet,
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
