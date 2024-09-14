const Application = require('../../lib/application');

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
    res.send(await Application.listModels());  
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
              "defaultPrompt": "You are operating the user service line for Flagco...",
              "supportsFunctions": true,
            },
            "palm2": {
              "description": "Google PaLM2 (BARD via Vertex AI)",
              "defaultPrompt": "You work for GFlags, a company that...",
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

