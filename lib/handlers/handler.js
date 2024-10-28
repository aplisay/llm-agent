const defaultLogger = require('../logger');
const Voices = require('../voices');
/**
 * Superclass for the handler interface which implements a runtime handler for one or more models
 *
 * @class Handler
 */
class Handler {

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
  }

  static _availableModels;

  static get availableModels() {
    if (!this._availableModels) {
      this._availableModels = this.models
        .filter((implementation) => implementation.canLoad)
        .reduce((o, implementation) => o.concat(
          implementation.allModels.map(([name, description]) => ({
            name: `${this.name}:${name}`,
            description,
            implementation
          }))
        ), []);
    }
    return this._availableModels;
  }

  static parseName(modelName = '' ) {
    // Syntax of a modelname is handler:provider/model e.g. jambonz:openai/gpt-4o
    // If handler not explicitly provided then default to class name
    const [[, , handler = this.name, provider, model]] =
      [...modelName.matchAll(/(([a-z0-9-_]*):)*([^\/]+)\/(.*)/g)];
    const implementation = this.models.find((m) => m.name === provider);
    return { handler, provider, implementation, model };
  }

  // Default is all voices we have configured, but this can be overridden
  static voices = (async (logger) => {
    return await (new Voices(logger)).listVoices();
  })(defaultLogger);

  constructor({ modelName, ...rest }) {
    const { handler, provider, implementation, model } = this.constructor.parseName(modelName);
    if (handler!== this.constructor.name) {
      throw new Error(`Handler ${handler} does not match ${this.constructor.name}`);
    }
    this.logger = logger.child({ user });
    this.model = new implementation({ modelName, ...rest });
    this.logger.debug({ handler: this.name, implementation , model }, 'client created');
  }

  /**
   * 
   * Default is that there is nothing to do to activate an instance of the handler, just return
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
}

module.exports = Handler;
