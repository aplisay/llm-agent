require('dotenv').config();
const Google = require('./google-aiplatform');
const aiplatform = require('@google-cloud/aiplatform');
const location = 'us-central1';

/**
 * Implements the LLM class for Google's PaLM2 model via the Vertex AI
 * interface.
 *
 * @class Palm2
 * @extends {Llm}
 */
class Palm2 extends Google {

  static allModels = [
    ["chat-bison@001", "Google PaLM2"]
  ]

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
  constructor(args) {
    super({ ...args, location, model: args.model || Palm2.allModels[0][0] });
  }
};
  

module.exports = Palm2;
