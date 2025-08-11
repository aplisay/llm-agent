import handlers from '../../lib/handlers/index.js';

let appParameters, log;


export default function (logger, voices) {

    log = logger;

  const voicesList = (async (req, res) => {
      log.debug({ voices, handlers }, 'voicesList');
      try {
        let voices = Object.fromEntries(await Promise.all((await handlers()).implementations.map(async ({ name, voices }) => ([name, await voices]))));
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