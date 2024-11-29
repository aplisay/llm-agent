require('dotenv').config();
const axios = require('axios');
const Llm = require('./llm');
const { OPENAI_API_KEY } = process.env;

const api = axios.create({
  baseURL: 'https://api.openai.com/v1', method: 'post', headers: {
    "Authorization": `Bearer ${OPENAI_API_KEY}`
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

  static allModels = [
    ["gpt-3.5-turbo", "OpenAI GPT-3.5 Turbo"],
    ["gpt-4o", "OpenAI GPT-4o"],
    ["gpt-4", "OpenAI GPT-4 Turbo"],
  ].map(([name, description]) => ([`${this.name.toLowerCase()}/${name}`, description]));


  static get needKey() {
    return { OPENAI_API_KEY };
  }

  /**
   * OpenAI implementation supports function calling
   *
   * @static 
   * @memberof OpenAi
   */
  static supportsFunctions = () => true;


  /**
   * Creates an instance of OpenAi.
   * @memberof OpenAi
   */
  constructor({ logger, user, prompt, options, modelName }) {
    super(...arguments);
    this.api = api;
    this.gpt = {
      model: modelName || OpenAi.allModels[0][0],
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
    this.model = this.gpt.model;
    logger.debug({ thisPrompt: this.prompt, prompt, gpt: this.gpt }, 'NEW OpenAi agent');
  }

  set prompt(newPrompt) {
    this._prompt = newPrompt;
    let system = this.gpt?.messages?.find(m => m.role === 'system');
    system && (system.content = this._prompt);
  }

  set functions(functions) {
    this._functions = functions;
    this.tools = functions && functions.map(({ name, description, input_schema }) => ({
      type: 'function',
      function: {
        name,
        description,
        parameters: input_schema
      }
    }));
  }

  get functions() { 
    return this._functions;
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
  async initial(callBack) {
    let res = await this.rawCompletion(null);
    callBack && callBack(res);
    return res;
  }


  /**
   * Generate the next round of chat response
   *
   * @param {string} input the user prompt input text
   * @return {string} the raw completion output from the GPT-3.5 model 
   * @memberof OpenAi
   */
  async rawCompletion(input) {
    try {
      input && this.gpt.messages.push({
        role: "user",
        content: input
      });
      let post = {
        ...this.gpt,
        tools: this.tools,
        max_tokens: process.env.MAX_TOKENS || 1024,
      };
      this.logger.debug({ input, post }, 'sending prompt to openai');
      let { data: completion } = await this.api.post('/chat/completions',
        post);
      
      this.logger.debug({ completion }, 'got completion from openai');

      this.gpt.messages.push(completion.choices[0].message);
      return {
        text: completion.choices[0].message.content,
        calls: completion.choices[0].message.tool_calls?.length && completion.choices[0].message.tool_calls.map(({ id, type, function: { name, arguments: args } }) => ({
          name,
          id,
          input: JSON.parse(args)
        }))
      };
    }
    catch (err) {
      this.logger.error(err, 'error in rawCompletion');
      return {
        text: 'Sorry, I had a problem completing your request. Please try again later.'
      };
    }
  }

  /**
 * Send a set of function call results back to generate the next round of responses
 * 
 * @param {Array} Array of id, result string tuples 
 * @returns the rawCompletion output 
 * @memberof OpenAi
 */
  async callResult(results, callBack) {
    results.forEach(({ name, id, result }) => this.gpt.messages.push({
      role: "tool",
      tool_call_id: id,
      name,
      content: result
    }));
    this.logger.debug({ results, gpt: this.gpt }, 'sending results to OpenAI');
    return this.rawCompletion(null);
  }

}


module.exports = OpenAi;
