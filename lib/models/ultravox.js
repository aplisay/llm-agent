require('dotenv').config();
const axios = require('axios');
const Llm = require('../llm');

if (!process.env.ULTRAVOX_API_KEY) {
  throw new Error('No ultravox api key, set ULTRAVOX_API_KEY in server environment ;');
}

const api = axios.create({
  baseURL: 'https://api.ultravox.ai/api/',
  headers: {
    'X-Unsafe-API-Key': process.env.ULTRAVOX_API_KEY
  }
});


/**
 * Implements the LLM class against the Ultravox model
 *
 * 
 * @param {Object} logger Pino logger instance
 * @param {string} user a unique user ID
 * @param {string} prompt The initial (system) chat prompt
 * @param {Object} options options
 * @param {number} options.temperature The LLM temperature
 *                 See model documentation
 * @class Ultravox
 * @extends {Llm}
 */
class Ultravox extends Llm {

  static allModels = [
    ["ultravox-0-4", "Ultravox 0.4"],
  ];

  /**
   * OpenAI implementation supports function calling
   *
   * @static 
   * @memberof OpenAi
   */
  static supportsFunctions = false;

  // Ultravox is an audio model so no STT and TTS is builtin etc
  static audioModel = true;

  /**
   * Creates an instance of Ultravox.
   * @memberof OpenAi
   */
  constructor() {
    super(...arguments);
    this.api = api;
    this.logger.info({ thisPrompt: this.prompt}, 'NEW Ultravox agent');
  }

  set prompt(newPrompt) {
    this._prompt = newPrompt;
    let system = this.gpt?.messages?.find(m => m.role === 'system');
    system && (system.content = this._prompt);
  }

  set functions(functions) {
    this.tools = functions && functions.map(({ name, description, input_schema }) => ({
      type: 'function',
      function: {
        name,
        description,
        parameters: input_schema
      }
    }));
  }

  get prompt() {
    return this._prompt;
  }

  set options(newOptions) {
    this._options = newOptions;
  }
  get options() {
    return this._options;
  }


  async startInband() {
    let { _prompt: systemPrompt, _options: options, logger } = this;

    try {
      logger.info({ systemPrompt, ...options }, 'Starting inband call');
      let { data: {
        callId,
        ended,
        joinUrl
      } } = await api.post('calls', {
        systemPrompt,
        ...options
      });
      if (ended || !callId?.length || !joinUrl?.length) {
        throw new Error('API call failed');
      }
      this.callId = callId;
      logger.info({ self: this }, 'In band call started');
      return { id: callId, socket: joinUrl };

    }
    catch (error) {
      console.error(error);
      throw new Error(`Call setup: ${error.message}`);
    }


  }

  async destroy() {

    let { callId, logger } = this;
    logger.info({ callId }, 'Inband call ending');

    try {
      if (!callId) {
        await api.delete(`calls/${callId}`);
      }
    }
    catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Inband call teardown: ${error.message}`);
    }

  }

}


module.exports = Ultravox;
