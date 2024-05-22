require('dotenv').config();
const axios = require('axios');
const Llm = require('../llm');

if (!process.env.GROQ_API_KEY) {
  throw new Error('No OpenAI api key, set GROQ_API_KEY in server environment');
}

const gpt = axios.create({
  baseURL: 'https://api.groq.com/openai/v1', method: 'post', headers: {
    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
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
 * @class Groq
 * @extends {Llm}
 */
class Groq extends Llm {

  static allModels = [
    ["llama3-8b-8192", "LLaMA3 8b"],
    ["llama3-70b-8192", "LLaMA3 70b"],
    ["mixtral-8x7b-32768", "Mixtral 8x7b"],
    ["gemma-7b-it", "Gemma 7b"],
  ];

  /**
   * OpenAI implementation supports function calling
   *
   * @static 
   * @memberof Groq
   */
  static supportsFunctions = true;

  /**
   * Creates an instance of Groq.
   * @memberof Groq
   */
  constructor({ logger, user, prompt, options, model }) {
    super(...arguments);
    this.gpt = {
      model: model || Groq.allModels[0][0],
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
    logger.info({ thisPrompt: this.prompt, prompt, gpt: this.gpt }, 'NEW Groq agent');
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
    newOptions?.temperature && this.gpt && (this.gpt.temperature = (2.0 * newOptions.temperature));
  }
  get options() {
    return this._options;
  }

  /**
   * Start the chat session and return the initial greeting
   *
   * @return {string} initial response
   * @memberof Groq
   */
  async initial() {
    let completion = gpt.post('/chat/completions', this.gpt);
    let { data } = await completion;

    return { text: data?.choices[0]?.message?.content || "Hello, how may I help you" };
  }


  /**
   * Generate the next round of chat response
   *
   * @param {string} input the user prompt input text
   * @return {string} the raw completion output from the GPT-3.5 model 
   * @memberof Groq
   */
  async rawCompletion(input) {
    input && this.gpt.messages.push({
      role: "user",
      content: input
    });
    let post = {
      ...this.gpt,
      tools: this.tools,
      max_tokens: process.env.MAX_TOKENS || 1024,
    };
    this.logger.info({ input, post }, 'sending prompt to openai');
    let { data: completion } = await gpt.post('/chat/completions',
      post);

    this.logger.info({ completion }, 'got completion from openai');

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

  /**
 * Send a set of function call results back to generate the next round of responses
 * 
 * @param {Array} Array of id, result string tuples 
 * @returns the rawCompletion output 
 * @memberof Groq
 */
  async callResult(results) {
    results.forEach(({ name, id, result }) => this.gpt.messages.push({
      role: "tool",
      tool_call_id: id,
      name,
      content: result
    }));
    this.logger.info({ results, gpt: this.gpt }, 'sending results to OpenAI');
    return this.rawCompletion(null);
  }

}


module.exports = Groq;
