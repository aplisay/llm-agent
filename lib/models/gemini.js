require('dotenv').config();
const Google = require('./google-vertexai');

const location = process.env.GOOGLE_PROJECT_LOCATION;
const model = "gemini-1.5-pro-preview-0409";

/**
 * Implements the LLM class for Google's Gemini model via the Vertex AI
 * interface.
 *
 * @class Gemini
 * @extends {Google}}
 */
class Gemini extends Google {
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
  constructor(logger, user, prompt, options) {
    super(logger, user, prompt, options, location, model);
  }
};


module.exports = Gemini;
