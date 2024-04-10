require('dotenv').config();
const axios = require('axios');
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
  /**
   * Creates an instance of Anthropic.
   * @memberof Anthropic
   */
  constructor(logger, user, prompt, options) {
    super(logger, user, prompt, options);
    this.gpt = {
      model: process.env.Anthropic_MODEL || 'claude-3-haiku-20240307',
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
  async initial() {
    return this.rawCompletion('hello');
  }


  /**
   * Generate the next round of chat response
   *
   * @param {string} input the user prompt input text
   * @return {string} the raw completion output from the GPT-3.5 model 
   * @memberof AnthropicLlm
   */
  async rawCompletion(input) {
    this.gpt.messages.push({
      role: "user",
      content: input
    });
    this.logger.info({ input, gpt: this.gpt }, 'sending prompt to Anthropic');
    let { id, type, content, role } = await anthropic.messages.create(this.gpt);
    let text = content.reduce((o, { type, text }) => (o + (type === 'text' ? text : '')), '');
    this.logger.info({ id, type, role, content }, 'got completion from Anthropic');
    this.gpt.messages.push({role, content});
    return text;
  }
}


module.exports = process.env.ANTHROPIC_API_KEY && AnthropicLlm;
