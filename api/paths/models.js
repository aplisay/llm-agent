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
  res.send(Application.listModels());
};
modelList.apiDoc = {
  summary: 'Returns list of valid model names',
  operationId: 'modelList',
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
          example: { 'gpt35': "GPT-3.5-turbo chat", palm2: "PaLM2 via Vertex AI" }
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

