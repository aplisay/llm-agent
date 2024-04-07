require('dotenv').config();
const Google = require('./google-aiplatform');
const aiplatform = require('@google-cloud/aiplatform');
const { EndpointServiceClient, PredictionServiceClient } = aiplatform.v1;
const { helpers } = aiplatform;

const projectId = process.env.GOOGLE_PROJECT_ID;
const location = 'us-central1';
const model = "chat-bison@001"

/**
 * Implements the LLM class for Google's PaLM2 model via the Vertex AI
 * interface.
 *
 * @class Palm2
 * @extends {Llm}
 */
class Palm2 extends Google {
  /**
   * Creates an instance of Palm2.
   * @param {Object} logger Pino logger instance
   * @param {string} user a unique user ID
   * @param {string} prompt The initial (system) chat prompt
   * @param {Object} options options
   * @param {number} options.temperature The LLM temperature
   *                 See model documentation
   * @memberof Palm2
   */
  constructor(logger, user, prompt, options) {
    super(logger, user, prompt, options, location, model);
  }
};
  

module.exports = Palm2;
