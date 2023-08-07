const Application = require('../../lib/application');

let appParameters, log;

module.exports =
  function (logger, googleHelper) {

    log = logger;

    const voicesList = (async (req, res) => {
      try {
        res.send(await googleHelper.listVoices());
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
          description: 'A list of available voices',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: {
                  type: "array",
                  items: {
                    $ref: '#/components/schemas/Voice'
                  }
                }
              },
              example: {
                'en-GB': [{ name: 'en-GB-Wavenet-A', gender: 'male' }, { name: 'en-GB-Wavenet-b', gender: 'female' }, { name: 'en-GB-Wavenet-C', gender: 'male' }],
                'ca-ES': [{ name: 'ca-ES-Wavenet-A', gender: 'male' }, { name: 'ca-ES-Wavenet-b', gender: 'female' }, { name: 'ca-ES-Wavenet-C', gender: 'male' }],
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

    console.log({ GET: voicesList }, 'voiceslist');

    return {
      GET: voicesList
    };



  };