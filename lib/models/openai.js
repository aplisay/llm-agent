require('dotenv').config();
const axios = require('axios');
const Llm = require('../llm');

if (!process.env.OPENAI_API_KEY) {
  throw new Error('No OpenAI api key, set OPENAI_API_KEY in server environment ;');
}

const gpt = axios.create({
  baseURL: 'https://api.openai.com/', method: 'post', headers: {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
  }
});


/**
 * Implements the LLM class against the OpenAI GPT3.5-turbo model
 *
 * 
 * @param {Object} logger Pino logger instance
 * @param {string} user a unique user ID
 * @param {string} prompt The initial (system) chat prompt
 * @param {Object} options options
 * @param {number} options.temperature The LLM temperature
 *                 See model documentation
 * @class OpenAi
 * @extends {Llm}
 */
class OpenAi extends Llm {
  /**
   * Creates an instance of OpenAi.
   * @memberof OpenAi
   */
  constructor(logger, user, prompt, options) {
    super(logger, user, prompt, options);
    this.gpt = {
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo-16k',
      user,
      presence_penalty: 0,
      //OpenAI now uses 0 <= temperature <= 2 so standardise
      temperature: (options?.temperature && (2.0 * options.temperature)) || 0.2,
      top_p: 0.5,
      messages: [
        {
          role: "system",
          content: prompt
        }
      ],
    };
    logger.info({ thisPrompt: this.prompt, prompt, gpt: this.gpt }, 'NEW OpenAi agent');
  }

  set prompt(newPrompt) {
    this._prompt = newPrompt;
    let system = this.gpt?.messages?.find(m => m.role === 'system');
    system && (system.content = this._prompt);
  }

  get prompt() {
    return this._prompt;
  }

  set options(newOptions) {
    this._options = newOptions;
    newOptions?.temperature && this.gpt && (this.gpt.temperature = (2.0 * newOptions.temperature));
  }
  get options() {
    return this._options;
  }

  /**
   * Start the chat session and return the initial greeting
   *
   * @return {string} initial response
   * @memberof OpenAi
   */
  async initial() {
    let completion = gpt.post('/v1/chat/completions', this.gpt);
    let { data } = await completion;

    return data?.choices[0]?.message?.content || "Hello, how may I help you";
  }


  /**
   * Generate the next round of chat response
   *
   * @param {string} input the user prompt input text
   * @return {string} the raw completion output from the GPT-3.5 model 
   * @memberof OpenAi
   */
  async rawCompletion(input) {
    this.gpt.messages.push({
      role: "user",
      content: input
    });
    this.logger.info({ input, gpt: this.gpt }, 'sending prompt to openai');
    let { data: completion } = await gpt.post('/v1/chat/completions',
      {
        ...this.gpt,
        max_tokens: process.env.MAX_TOKENS || 1024,
      });
    this.logger.info({ completion }, 'got completion from openai');


    this.gpt.messages.push(completion.choices[0].message);
    return completion.choices[0].message.content;
  }
}


module.exports = OpenAi;
