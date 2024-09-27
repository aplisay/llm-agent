/**
 * Superclass for an Llm interface: generic constructor, completion and hint parsing
 *
 * @class Llm
 */
class Llm {


  /**
   * Default us not to support function calling
   *
   * @static supportsFunctions
   * @memberof Llm
   */
  static supportsFunctions = () => false
 
  /**
   *
   * 
   * @param {Object} logger Pino logger instance
   * @param {string} user a unique user ID
   * @param {string} prompt The initial (system) chat prompt
   * @param {Object} options options
   * @param {number} options.temperature The LLM temperature
   *                 See model documentation
   * @memberof Llm
   */
  constructor({ logger, user, prompt, functions, options, model }) {
    if (functions && !this.constructor.supportsFunctions(model)) {
      throw new Error('Functions not supported by this model');
    }
    // Do this early because some setters have logging dependency
    this.logger = logger.child({ user });
    Object.assign(this, {
      options,
      initialPrompt: prompt,
      _prompt: prompt,
      prompt,
      functions: functions?.length ? functions : undefined,
      user,
    });
    this.logger.info({ init: this, prompt }, 'client created');
  }

  /**
   * This used to do useful stuff parsing inline function calls, but now that most
   * models support function calling we have deprecated this code and it is a no-op
   *  
   * @typedef {Object} Completion
   * @property {string} text parsed text string with \n's translated to breaks and directives removed
   * @property {Object} call embedded function calls
   * @property {Objectn} error any errors that occured
   * @memberof Llm
   */
  async completion(input, callBack) {
    let { text , calls, error } = await this.rawCompletion(input);
    let opts = { text, calls, error };
    this.logger.info({ opts }, 'completion returning');
    callBack(opts);
    return opts;
  }


  /**
   * A list of all the unique words in the initial prompt.
   * Useful as hints for STT context priming.
   *
   * @readonly
   * @memberof Llm
   */
  get voiceHints() {
    let hints = this._hints || [...new Set(this.initialPrompt.split(/[^a-zA-Z0-9]/))].filter(h => h.length > 2);
    return (this._hints = hints);
  }

  get prompt() {
    return this._prompt;
  }
}

module.exports = Llm;
