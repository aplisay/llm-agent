const defaultLogger = require('../logger');
const Voices = require('../voices');
const { Instance, Call, TransactionLog, PhoneNumber
 } = require('../database');
/**
 * Superclass for the handler interface which implements a runtime handler for one or more models
 *
 * @class Handler
 */
class Handler {

  /**
   * Checks if this implementation needs auth keys and should not be loaded if they
   * are not present.
   * Returns an object with a `ok` property and a `need` property
   * @returns {Object} - An object with a `ok` property and a `need` property
   *                     `ok` set to true if all keys are present, false otherwise
   *                     `need` always has list of key names
   */
  static get canLoad() {
    return this.needKey
      ? { ok: Object.values(this.needKey).reduce((o, k) => (o && !!k), true), need: Object.keys(this.needKey) }
      : { ok: true };
  }

  static _availableModels;

  /**
 * Returns an array of available models for this handler
 * @returns {Array} - An array of objects that describe available models
 * @example
 * [
 *   {
 *     name: 'jambonz:openai/gpt-4o',
 *     supportsFunctions: true,
 *     description: 'Description for model1',
 *     implementation: class OpenAi extends Llm 
 *   },
 *   {
 *     name: 'ultravox:ultravox/llama-3.1-70B',
 *     supportsFunctions: true,
 *     description: 'Description for model2',
 *     implementation: class Ultravox extends Llm
 *   }
 * ]
 */
  static get availableModels() {
    if (!this._availableModels) {
      this._availableModels = this.models
        .filter((implementation) => implementation.canLoad)
        .reduce((o, implementation) => o.concat(
          implementation.allModels.map(([name, description]) => ({
            name: `${this.name}:${name}`,
            supportsFunctions: implementation.supportsFunctions(name),
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
    const implementation = this.models?.find((m) => m.name.toLowerCase() === provider);
    return { handler, provider, implementation, model };
  }

  static getHandler(modelName, list, models) {
    let { handler } = this.parseName(modelName, models);
    return handler && list.find((m) => m.name === handler);
  }

  // Default is all voices we have configured, but this can be overridden
  static get voices() {
    defaultLogger.debug({ handler: this.name }, 'voices requested');
    return (new Voices(defaultLogger)).listVoices();
  } 

  constructor({ agent, wsServer, logger = defaultLogger, ...rest }) {
    Object.assign(this, { agent, wsServer });
    const { handler, provider, implementation, model } = this.constructor.parseName(agent.modelName);
    if (handler!== this.constructor.name) {
      throw new Error(`Handler ${handler} does not match ${this.constructor.name}`);
    }
    this.logger = logger.child({ handler });
    this.model = new implementation({ ...agent.dataValues, logger });
    Object.assign(this, { agent, wsServer, implementation });
    this.logger.debug({ handler: this.name, implementation , model }, 'client created');
  }

  async activate({ number, options = {} } = {}) {
    let { streamLog = false } = options;
    let { agent, wsServer, logger, callbackUrl } = this;
    if (!this.agent.id) {
      throw new Error('No current agent');
    }
    let { id } = agent;
    let progressPath = `/progress/${id}`;
    logger.info({ agent, streamLog, options }, `activating agent ${agent.id} with number ${number}`);
    let type = this.constructor.name;
    try {
      let instance = await Instance.create({ agentId: agent.id, type, streamLog });
      let allocated = await instance.linkNumber(type, number);
      this.progress = { send: () => (null) };
      wsServer.createEndpoint(progressPath, (ws) => {
        this.ws = ws;
        ws.send(JSON.stringify({ hello: true }));
        this.progress = {
          send: async (msg) => {
            logger.info({ msg }, 'sending message');
            ws.send(JSON.stringify(msg));
            callbackUrl && this.callbackTries > 0 && axios.post(callbackUrl, msg).catch((e) => {
              --this.callbackTries || this.logger.error({ callbackUrl, tries: this.callbackTries, error: e.message }, 'Callback disabled');
              this.logger.info({ callbackUrl, tries: this.callbackTries, error: e.message }, 'Callback failed');
            });
          }
        };
        ws.on('error', (err) => {
          this.logger.error({ err }, `received socket error ${err.message}`);
        })
          .on('close', (code, reason) => {
            this.logger.info({ code, reason }, `socket close`);
            this.destroy();
          });
      });

      logger.info({ id: instance.id }, `activation result`);
      TransactionLog.on(instance.id, async (transactionLog) => {
        logger.info({ transactionLog }, `Got transactionlog`);
        this.progress.send(
          transactionLog
        );
      });
      return { id: instance.id, number: allocated, socket: progressPath };
    }
    catch (e) {
      logger.error(e, `activation failed`);
      return null;
    }
  }
}

console.log('Handler', Handler);
module.exports = Handler;