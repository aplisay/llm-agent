require('dotenv').config();
const axios = require('axios');
const Llm = require('./llm');
const OpenAi = require('./openai');
const { GROQ_API_KEY } = process.env;

const api = axios.create({
  baseURL: 'https://api.groq.com/openai/v1', method: 'post', headers: {
    "Authorization": `Bearer ${GROQ_API_KEY}`
  }
});


/**
 * Implements the LLM class against the Groq cloud API
 * to snag some open source models. Groq cloud looks *very*
 * like OpenAI for our purposes so we mostly just provide a 
 * constructor for the groq endpoint and inherit all the OpenAi
 * methods
 * 
 * @param {Object} logger Pino logger instance
 * @param {string} user a unique user ID
 * @param {string} prompt The initial (system) chat prompt
 * @param {Object} options options
 * @param {number} options.temperature The LLM temperature
 *                 See model documentation
 * @class Groq
 * @extends {Llm}
 */
class Groq extends OpenAi {

  static allModels = [
    ["llama3-8b-8192", "LLaMA3 8B"],
    ["llama3-70b-8192", "LLaMA3 70B"],
    ["mixtral-8x7b-32768", "Mixtral 8x7B"],
    ["gemma-7B-it", "Gemma 7B"],
  ];

  static needKey = { GROQ_API_KEY };

  /**
   * Groq implementation supports function calling
   * This may be a lie for some models, tbd.
   *
   * @static 
   * @memberof Groq
   */
  static supportsFunctions = (model) => !!model.match(/-70b-/i);

  /**
   * Creates an instance of Groq.
   * 
   * @memberof Groq
   */
  constructor({ logger, user, prompt, options, model }) {
    super(...arguments);
    this.api = api;
    logger.info({ thisPrompt: this.prompt, prompt, gpt: this.gpt }, 'NEW Groq agent');
  }

 

}


module.exports = Groq;
