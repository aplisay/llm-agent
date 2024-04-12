require('dotenv').config();
const Google = require('./google-vertexai');

const location = process.env.GOOGLE_PROJECT_LOCATION;

/**
 * Implements the LLM class for Google's Gemini model via the Vertex AI
 * interface.
 *
 * @class Gemini
 * @extends {Google}}
 */
class Gemini extends Google {

  static allModels = [
    ["gemini-1.0-pro", "Google Gemini Pro 1.0"],
    ["gemini-1.5-pro-preview-0409", "Google Gemini Pro 1.5 Preview (0409)"],
  ]

  /**
   * Creates an instance of Gemini.
   * @param {Object} logger Pino logger instance
   * @param {string} user a unique user ID
   * @param {string} prompt The initial (system) chat prompt
   * @param {Object} options options
   * @param {number} options.temperature The LLM temperature
   *                 See model documentation
   * @memberof Gemini
   */
  constructor(arg) {
    super({ ...arg, model: arg.model || Gemini.allModels[0][0], location });
  }
};


module.exports = Gemini;
