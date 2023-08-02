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
                    type: "string",
                    description: "Voice name",
                  }
                }
              },
              example: {
                'en-GB': ["en-GB-Standard-A", "en-GB-Standard-B", "en-GB-Wavenrt-A", "en-GB-Wavenet-B"],
                'en-US': ["en-US-Standard-A", "en-US-Standard-B", "en-US-Wavenet-A", "en-US-Wavenet-B"]
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