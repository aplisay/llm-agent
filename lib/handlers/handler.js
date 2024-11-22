const defaultLogger = require('../logger');
const Voices = require('../voices');
const { Instance, Agent, TransactionLog } = require('../database');
const WebSocket = require('ws');
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

  static hasTelephony = false;
  static hasWebRTC = false;

  static liveInstances = {};
  static async deactivateAll() {
    try {
      return Promise.all(Object.values(Handler.liveInstances)
        .map((instance) => instance.deactivate())
      );
    } catch (e) {
      defaultLogger.error(e, 'failed to deactivate all instances');
    }
  }

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
            hasTelephony : this.hasTelephony,
            hasWebRTC: this.hasWebRTC,
            description,
            implementation
          }))
        ), []);
    }
    return this._availableModels;
  }

  static parseName(modelName = '') {
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

  static async fromInstance(instanceId, logger = defaultLogger) {
    let instance = await Instance.findByPk(instanceId, { include: Agent });
    let { Agent: agent } = instance || {};
    if (!instance || !agent) {
      return null;
    }

    return new this({ agent, instance, logger });
  }

  constructor({ agent, instance, logger = defaultLogger, ...rest }) {
    Object.assign(this, { agent, instance, logger });
    const { handler, implementation, model } = this.constructor.parseName(agent.modelName);

    this.model = implementation && new implementation({ ...agent.dataValues, logger });
    logger.debug({agent, handler, implementation, model: this.model}, 'NEW handler created');
    Object.assign(this, { agent, implementation });
    this.logger.debug({ handler: this.name, implementation, model, logger: this.logger }, 'client created');
  }

  async activate({ number, options = {} } = {}) {
    let { streamLog = false } = options;
    let { agent, logger } = this;
    if (!this.agent.id) {
      throw new Error('No current agent');
    }
    let { id } = agent;
    let progressPath;
    logger.debug({ agent, streamLog, options }, `activating agent ${agent.id} with number ${number}`);
    // Ultravox uses jambonz for SIP ingress so uses numbers from Jambonz pool
    let type = this.constructor.name === 'ultravox' ? 'jambonz' : this.constructor.name;
    try {
      let instance = this.instance = await Instance.create({ agentId: agent.id, type, streamLog });
      let allocated = this.number = number && await instance.linkNumber(type, number);
      progressPath = `/progress/${instance.id}`;
      this.progress = { send: () => (null) };
      this.logger.debug({ instance, id: instance.id, number: allocated, socket: progressPath }, 'activation result');
      return { id: instance.id, number: allocated, socket: progressPath };
    }
    catch (e) {
      logger.error(e, `activation failed`);
      return null;
    }
  }

  async setStreamUrl(url) {
    let { instance } = this;
    if (!instance) {
      throw new Error('No current instance');
    }
    await instance.update({ streamUrl: url });
    await instance.save();
  }


  async handleUpdates(ws) {
    let { instance, logger, callbackUrl } = this;

    logger.debug({ instance, ws }, 'handleUpdates');
    if (!instance || !ws) {
      throw new Error('No current instance');
    }
    logger.debug({ instance, id: instance.id }, 'handleUpdates called');
    this.ws = ws;
    this.progress = {
      send: async (msg) => {
        logger.debug({ msg }, 'sending message');
        ws.send(JSON.stringify(msg));
        callbackUrl && this.callbackTries > 0 && axios.post(callbackUrl, msg).catch((e) => {
          --this.callbackTries || this.logger.error({ callbackUrl, tries: this.callbackTries, error: e.message }, 'Callback disabled');
          this.logger.debug({ callbackUrl, tries: this.callbackTries, error: e.message }, 'Callback failed');
        });
      }
    };
    Handler.liveInstances[instance.id] = this;
    ws.on('error', (err) => {
      this.logger.error({ err }, `received socket error ${err.message}`);
    })
      .on('close', (code, reason) => {
        this.logger.debug({ code, reason }, `socket close`);
        this.deactivate();
      });
    TransactionLog.on(instance.id, async (transactionLog) => {
      logger.debug({ transactionLog }, `Got transactionlog`);
      this.progress.send(
        transactionLog
      );
    });
  }

  async handleAudio(ws) {
    let { instance, logger, callbackUrl } = this;
    let stream;

    if (!instance || !ws) {
      throw new Error('No current instance');
    }
    this.logger.debug({ id: instance.id, ws }, 'handleAudio called with websocket');

    if (instance.streamUrl) {
      stream = new WebSocket(instance.streamUrl);
      stream.on('error', (err) => {
        this.logger.error({ err }, `received stream error ${err.message}`);
        ws.close();
      });
      stream.on('close', (code, reason) => {
        this.logger.info({ code, reason }, `stream close`);
        ws.close();
      });
      stream.on('message', (msg) => {
        this.logger.info({ msg }, `received stream message from LLM`);
        ws.close();
      })
      ws.on('message', async (msg) => {
        logger.debug({ msg }, 'received stream message from Jambonz');
        stream && stream.write(msg);
      });
      
    }
    else {
      this.logger.error({ instance }, 'No streamUrl');
      return;
    }
  }

  async deactivate() {
    let { instance, ws, logger } = this;
    let { id } = instance || {};
    try {
      if (!id) {
        throw new Error('No current agent');
      }
      logger.debug({ instance }, `deactivating agent ${instance.id}`);
      await instance.destroy();
      ws?.close && await ws.close();
    }
    catch (e) {
      logger.error(e, `on deactivation`);
    }
    finally {
      if (Handler.liveInstances[id]) {
        delete Handler.liveInstances[id];
      }
    }
  }
}

module.exports = Handler;