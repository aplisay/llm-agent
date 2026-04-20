import {
  getModelVoiceLocales,
} from '../../../../lib/model-voices.js';

export default function (logger, voices) {
  const modelVoicesLocalesGet = async (req, res) => {
    try {
      const modelName = decodeModelParam(req.params.modelName);
      const body = await getModelVoiceLocales({ modelName, voicesInstance: voices });
      res.send(body);
    } catch (err) {
      const code = err.statusCode || 500;
      req.log.error({ err, modelName: req.params.modelName }, 'model voices locales');
      res.status(code).send({ error: err.message || String(err) });
    }
  };

  modelVoicesLocalesGet.apiDoc = {
    summary: 'List TTS locales for a model',
    description: `Returns locale codes suitable for the language selector when configuring an agent.

Use **URL-encoded** \`modelName\` as a single path segment (e.g. \`livekit%3Aopenai%2Fgpt-4o\` for \`livekit:openai/gpt-4o\`).

- **LiveKit pipeline** models: locales are derived from configured Inference TTS providers (Deepgram, ElevenLabs, Cartesia, etc.). Google Cloud catalogue voices are omitted from this list because the Node pipeline uses Gemini TTS, not Cloud voice ids.
- **LiveKit realtime** and other handlers: locales match the legacy nested voice map (often \`any\` for Ultravox/OpenAI realtime).

Prefer this over [\`GET /voices\`](#operation-voicesList).`,
    operationId: 'modelVoiceLocales',
    tags: ['Models'],
    deprecated: false,
    parameters: [
      {
        in: 'path',
        name: 'modelName',
        required: true,
        description: 'Full model id; URL-encode reserved characters (`:`, `/`).',
        schema: { type: 'string' },
        example: 'livekit%3Aopenai%2Fgpt-4o',
      },
    ],
    responses: {
      200: {
        description: 'Locales and optional stack hint',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                locales: {
                  type: 'array',
                  items: { type: 'string' },
                  example: ['en-GB', 'en-US'],
                },
                voiceStack: {
                  type: 'string',
                  enum: ['realtime', 'pipeline'],
                },
              },
              required: ['locales'],
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
    GET: modelVoicesLocalesGet,
  };
}

/** Express leaves `%2F` encoded in some setups; normalise segment to full model id. */
function decodeModelParam(raw) {
  if (raw == null) return '';
  try {
    return decodeURIComponent(String(raw));
  } catch {
    return String(raw);
  }
}
