import {
  getModelRecognitionForLocale,
} from '../../../../../lib/model-voices.js';

export default function (logger) {
  const modelRecognitionLocaleGet = async (req, res) => {
    try {
      const modelName = decodeParam(req.params.modelName);
      const locale = decodeParam(req.params.locale);
      const body = await getModelRecognitionForLocale({ modelName, locale });
      res.send(body);
    } catch (err) {
      const code = err.statusCode || 500;
      req.log.error({ err, modelName: req.params.modelName, locale: req.params.locale }, 'model recognition locale');
      res.status(code).send({ error: err.message || String(err) });
    }
  };

  modelRecognitionLocaleGet.apiDoc = {
    summary: 'List STT providers for a model and locale',
    description: `Returns the speech-to-text provider options for the given model and locale.

Use **URL-encoded** \`modelName\` as a single path segment (e.g. \`livekit%3Aopenai%2Fgpt-4o\` for \`livekit:openai/gpt-4o\`).

- **LiveKit pipeline** models: returns the set of supported Inference STT vendors (Deepgram, AssemblyAI, Cartesia).
- **All other models**: returns an empty provider list (STT vendor is fixed by the pipeline).`,
    operationId: 'modelRecognitionLocale',
    tags: ['Models'],
    parameters: [
      {
        in: 'path',
        name: 'modelName',
        required: true,
        description: 'Full model id; URL-encode reserved characters (`:`, `/`).',
        schema: { type: 'string' },
        example: 'livekit%3Aopenai%2Fgpt-4o',
      },
      {
        in: 'path',
        name: 'locale',
        required: true,
        description: 'BCP-47 locale code, e.g. `en-GB`.',
        schema: { type: 'string' },
        example: 'en-GB',
      },
    ],
    responses: {
      200: {
        description: 'STT provider list and optional stack hint',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                providers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', example: 'deepgram' },
                      description: { type: 'string', example: 'Deepgram Nova 3' },
                    },
                    required: ['name', 'description'],
                  },
                },
                voiceStack: {
                  type: 'string',
                  enum: ['realtime', 'pipeline'],
                },
              },
              required: ['providers'],
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
    GET: modelRecognitionLocaleGet,
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
