require('dotenv').config();
const Llm = require('../llm');
const { Anthropic } = require('@anthropic-ai/sdk');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('No ANTHROPIC_API_KEY api key set in server environment. Set one if you wish to provide the Claude models');
}

const anthropic = new Anthropic();

/**
 * Implements the LLM class against the Anthropic Claude models
 *
 * 
 * @param {Object} logger Pino logger instance
 * @param {string} user a unique user ID
 * @param {string} prompt The initial (system) chat prompt
 * @param {Object} options options
 * @param {number} options.temperature The LLM temperature
 *                 See model documentation
 * @class Anthropic
 * @extends {Llm}
 */
class AnthropicLlm extends Llm {

  static allModels = [
    ["claude-3-haiku-20240307", "Anthropic Claude 3 Haiku"],
    ["claude-3-sonnet-20240229", "Anthropic Claude 3 Sonnet"],
    ["claude-3-5-sonnet-20240620", "Anthropic Claude 3.5 Sonnet"],
    ["claude-3-opus-20240229", "Anthropic Claude 3 Opus"],
  ]

  
/**
 * Anthropic interface supports function calling
 *
 * @static supportsFunctions
 * @memberof AnthropicLlm
 */
  static supportsFunctions = () => true;

  /**
   * Creates an instance of Anthropic.
   * @memberof Anthropic
   */
  constructor({ logger, prompt, options, model }) {
    super(...arguments);
    this.gpt = {
      model: model || AnthropicLlm.allModels[0][0],
      temperature: options?.temperature || 0.2,
      max_tokens: 1024,
      system: prompt,
      messages: [
      ],
    };
    logger.info({ thisPrompt: this.prompt, prompt, gpt: this.gpt }, 'NEW Anthropic agent');
  }

  set prompt(newPrompt) {
    this._prompt = newPrompt;
    this.gpt && (this.gpt.system = this._prompt);
  }

  get prompt() {
    return this._prompt;
  }

  set functions(functions) {
    this.tools = functions;
    this.logger && this.logger.info({ functions, tools: this.tools }, 'Set functions');
  }

  set options(newOptions) {
    this._options = newOptions;
    newOptions?.temperature && this.gpt && (this.gpt.temperature = newOptions.temperature);
  }
  get options() {
    return this._options;
  }

  /**
   * Start the chat session and return the initial greeting
   *
   * @return {string} initial response
   * @memberof AnthropicLlm
   */
  async initial(callBack) {
    this.logger.debug({ callBack }, 'Anthropic initial');
    return this.rawCompletion('hello', callBack);
  }


  /**
   * Generate the next round of chat response
   *
   * @param {string} input the user prompt input text
   * @return {string} the raw completion output from the GPT-3.5 model 
   * @memberof AnthropicLlm
   */
  async rawCompletion(input, callBack) {
    input && this.gpt.messages.push({
      role: "user",
      content: input
    });
    this.logger.info({ input, callBack, call:{ ...this.gpt, tools: this.tools } }, 'sending prompt to Anthropic');
    let { id, type, content, role } = await anthropic.beta.tools.messages.create({ ...this.gpt, tools: this.tools });
    let text = content.reduce((o, { type, text }) => (o + (type === 'text' ? text : '')), '');
    let calls = content.filter(c => c.type === 'tool_use')
      .map(({ name, id, input }) => ({ name, id, input }));
    this.logger.info({ id, type, role, content }, 'got completion from Anthropic');
    this.gpt.messages.push({ role, content });
    callBack && callBack({ text, calls });
    return { text, calls };
  }

/**
 * Send a set of function call results back to generate the next round of responses
 * 
 * @param {Array} Array of id, result string tuples 
 * @returns the rawCompletion output 
 * @memberof AnthropicLlm
 */
  async callResult(results) {
    this.gpt.messages.push({
      role: "user",
      content: results.map(({ id, result }) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: result
      }))
    });
    this.logger.info({ results, gpt: this.gpt }, 'sending results to Anthropic');
    return this.rawCompletion(null);
  }
  
}


module.exports = process.env.ANTHROPIC_API_KEY && AnthropicLlm;
