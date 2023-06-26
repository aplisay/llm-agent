require('dotenv').config();
const axios = require('axios');
const Llm = require('./llm');

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
 *    * Creates an instance of Gpt35.
   * @param {Object} logger Pino logger instance
   * @param {string} user a unique user ID
   * @param {string} prompt The initial (system) chat prompt
   * @param {Object} options options
   * @param {number} options.temperature The LLM temperature
   *                 See model documentation
 * @class Gpt35
 * @extends {Llm}
 */
class Gpt35 extends Llm {
  /**
   * Creates an instance of Gpt35.
   * @memberof Gpt35
   */
  constructor(logger, user, prompt, options) {
    super(logger, user, prompt, options);
    //OpenAI now uses 0 <= temperature <= 2 so standardise
    options?.temperature && (options.temperature = (options.temperature * 2));
    this.gpt = {
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      user,
      presence_penalty: 0,
      temperature: 0.2,
      top_p: 0.5,
      messages: [
        {
          role: "system",
          content: this.prompt
        }
      ],
      ...options
    };
    logger.info({ thisPrompt: this.prompt, prompt, gpt: this.gpt }, 'NEW GPT35agent');
  }


  /**
   * Start the chat session and return the initial greeting
   *
   * @return {string} initial response
   * @memberof Gpt35
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
   * @memberof Gpt35
   */
  async rawCompletion(input) {
    this.gpt.messages.push({
      role: "user",
      content: input
    });
    this.logger.info({ input }, 'sending prompt to openai');
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
     
 
module.exports = Gpt35;
