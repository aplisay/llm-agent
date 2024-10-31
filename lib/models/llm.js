/**
 * Superclass for an Llm interface: generic constructor, completion and hint parsing
 *
 * @class Llm
 */
class Llm {


  /**
   * The name of the handler for this implementation, defaults to `jambonz`
   * for now as this where we currently implement the most models.
   */
  static handler = 'jambonz';


  /**
   * Default us not to support function calling
   *
   * @static supportsFunctions
   * @memberof Llm
   */
  static supportsFunctions = () => false;

  /**
   * If this implementation needs auth keys and should not be loaded if they
   * are not present then `ok` in the returned object is set to `false` and
   * the missing keys are enumerated in the `need` property if they are not set.
   * Otherwise `ok` is unconditionally set to `true`.
   * 
   * @returns {Object} an object with a `ok` property and a `need` property
   * 
   */
  static get canLoad() {
    return this.needKey
      ? { ok: Object.values(this.needKey).reduce((o, k) => (o && !!k), true), need: Object.keys(this.needKey) }
      : { ok: true };
  };

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
  constructor({ logger, user, prompt, functions, options, modelName }) {
    if (functions && !this.constructor.supportsFunctions(modelName)) {
      throw new Error('Functions not supported by this model');
    }
    // Do this early because some setters have logging dependency
    this.logger = logger.child({ user });
    Object.assign(this, {
      modelName,
      options,
      initialPrompt: prompt,
      _prompt: prompt,
      prompt,
      functions: functions?.length ? functions : undefined,
      user,
    });
    this.logger.info({ init: this, prompt }, 'client created');
  }

  // Strip the provider from the model name for most providers
  //  can be overriden by the derived implementation as needed
  set model(newModel) {
    this.gpt = { ...(this.gpt || {}), model: newModel.replace(/^.*\//, '') };
  }

  get model() {
    return this.gpt.model;
  }



  /**
   * 
   * Default is that there is nothing to do to activate an instance of the room, just return
   * the passed instanceId.
   * Derived classes can override this to do useful stuff (eg create a WebRTC room and return it
   * to the client).
   * 
   * @param {string} instanceId 
   * @returns {object}
   */
  async activate(instanceId) {
    return { id: instanceId };
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
    let { text, calls, error } = await this.rawCompletion(input);
    let opts = { text, calls, error };
    this.logger.info({ opts }, 'completion returning');
    callBack && callBack(opts);
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
    let hints = this._hints || (this.prompt?.length && [...new Set(this.prompt.split(/[^a-zA-Z0-9]/))].filter(h => h.length > 2));
    return (this._hints = hints);
  }

}

module.exports = Llm;
