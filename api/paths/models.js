const handlers = require('../../lib/handlers');

let appParameters, log;

module.exports = function (logger) {
  (appParameters = {
    logger,
  });
  log = logger;
  return {
    GET: modelList,
  };
};

const modelList = async (req, res) => {
  try {
    res.send(Object.fromEntries(
      handlers.models.map(({ name, description, supportsFunctions, implementation, hasTelephony, hasWebRTC}) => (
        [name,
        {
          description,
          supportsFunctions,
          audioModel: implementation.audioModel,
          hasTelephony,
          hasWebRTC,
        }
        ]
      ))
    )
    );
  } catch (err) {
    res.log.error(err);
    res.status(500).send(err);
  }
};
modelList.apiDoc = {
  summary: 'Returns list of valid model names',
  operationId: 'modelList',
  tags: ["Models"],
  responses: {
    200: {
      description: 'A list of available models.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: {
              $ref: '#/components/schemas/Model'
            }
          },
          example: {
            "gpt35": {
              "description": "GPT3.5-turbo chat",
              "supportsFunctions": true,
            },
            "palm2": {
              "description": "Google PaLM2 (BARD via Vertex AI)",
              "supportsFunctions": false,
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

