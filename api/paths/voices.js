import handlers from '../../lib/handlers/index.js';

let appParameters, log;


export default function (logger, voices) {

    log = logger;

  const voicesList = (async (req, res) => {
      try {
        let voices = Object.fromEntries((await Promise.all((await handlers()).implementations
          // A handler family whose transport credentials are unset isn't in the
          // bundle, so don't advertise its voices — and, more importantly, don't
          // await a `voices` static that rejects because its live catalogue API
          // (e.g. jambonz, ultravox) has no server/key, which would 500 the whole
          // endpoint.
          .filter((impl) => impl.canLoad.ok)
          .map(async ({ name, voices }) => ([name, await voices]))))
          // Headless handlers (e.g. `text` agents) have no TTS leg so don't belong in the voices list
          .filter(([, handlerVoices]) => handlerVoices && Object.keys(handlerVoices).length));
        res.send(voices);
      }
      catch (err) {
        res.status(500).send(err);
        req.log.error(err, 'getting voices');
      }
    });
    voicesList.apiDoc = {
      summary: 'Returns list of valid TTS voice models',
      operationId: 'voicesList',
      deprecated: true,
      description: 'Deprecated. Use `GET /models/{modelName}/voices` and `GET /models/{modelName}/voices/{locale}` so voice and language choices match the selected model (especially LiveKit pipeline vs realtime).',
      tags: ["Voices"],
      responses: {
        200: {
          description: 'A list of available providers and nested list of voices they each provide',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  additionalProperties: {
                    type: "object",
                    additionalProperties: {
                      type: "array",
                      items: {
                        $ref: '#/components/schemas/Voice'
                      }
                    }
                  }
                }
              },
              example: {
                jambonz: {
                  'google': {
                    'en-GB': [{ name: 'en-GB-Wavenet-A', gender: 'male' }, { name: 'en-GB-Wavenet-b', gender: 'female' }, { name: 'en-GB-Wavenet-C', gender: 'male' }],
                    'ca-ES': [{ name: 'ca-ES-Wavenet-A', gender: 'male' }, { name: 'ca-ES-Wavenet-b', gender: 'female' }, { name: 'ca-ES-Wavenet-C', gender: 'male' }],
                  }
                }
              }

            }
          }
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


    return {
      GET: voicesList
    };



  };