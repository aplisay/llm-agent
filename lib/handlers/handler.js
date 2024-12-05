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
            hasTelephony: this.hasTelephony,
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

  static async fromInstance(instanceId, list, models, logger = defaultLogger) {
    let instance = await Instance.findByPk(instanceId, { include: Agent });
    let { Agent: agent } = instance || {};
    if (!instance || !agent) {
      return null;
    }
    let SubClass = this.getHandler(agent.modelName, list, models);
    return new SubClass({ agent, instance, logger });
  }

  constructor({ agent, instance, logger = defaultLogger, ...rest }) {
    Object.assign(this, { agent, instance, logger });
    const { handler, implementation, model } = this.constructor.parseName(agent.modelName);

    this.model = implementation && new implementation({ ...agent.dataValues, logger });
    logger.debug({ agent, handler, implementation, model: this.model }, 'NEW handler created');
    Object.assign(this, { agent, implementation });
    this.logger.debug({ handler: this.name, implementation, model, logger: this.logger }, 'client created');
  }

  async activate({ number, options = {} } = {}) {
    let { streamLog = false } = options;
    let { agent, logger } = this;
    if (!this.agent.id) {
      throw new Error('No current agent');
    }
    let { id, userId, organisationId } = agent;
    let progressPath;
    logger.debug({ agent, streamLog, options }, `activating agent ${agent.id} with number ${number}`);
    // Ultravox uses jambonz for SIP ingress so uses numbers from Jambonz pool
    let type = this.constructor.name === 'ultravox' ? 'jambonz' : this.constructor.name;
    await this.preWarmup();

    let instance = this.instance = await Instance.create({ agentId: agent.id, userId, organisationId, type, streamLog });
    let allocated = this.number = number && await instance.linkNumber(type, number);
    if (number && !allocated) {
      throw new Error(`No number available for agent ${id} (requested ${number})`);
    }
    progressPath = `/progress/${instance.id}`;
    this.progress = { send: () => (null) };
    this.logger.debug({ instance, id: instance.id, number: allocated, socket: progressPath }, 'activation result');
    return { id: instance.id, number: allocated, socket: progressPath };


  }

  async preWarmup() {
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
    let { instance, logger } = this;
    let stream, callId, state, streamUrl;

    setTimeout(() => {
      if (!state || (state !== 'open' && state !== 'closed')) {
        logger.info({ callId, state, streamUrl }, 'LLM audio socket setup timeout');
        ws.close();
      }
    }, 5000);

    if (!instance || !ws) {
      throw new Error('No current instance');
    }
    logger.debug({ id: instance.id, ws }, 'handleAudio called with websocket');

    let outBuffer = [];

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        (stream && stream.readyState === WebSocket.OPEN && stream.send(data)) || outBuffer.push(data);
      }
      else {
        let message = JSON.parse(data.toString());
        ({ callId, streamUrl } = message);
        logger.debug({ message }, 'received data message from Jambonz');
        if (!stream && streamUrl && callId) {
          Object.assign(this, { streamUrl, callId });
          state = 'connecting';
          logger.debug({ id: instance.id, streamUrl }, 'websocket stream connecting');
          stream = new WebSocket(message.streamUrl);
          stream.on('open', () => {
            state = 'open';
            logger.debug({ id: instance.id, backlog: outBuffer.length }, 'websocket stream open');
            while (outBuffer.length) {
              stream.send(outBuffer.shift());
            }
          });
          stream.on('error', (err) => {
            logger.error({ err }, `received stream error ${err.message}`);
            ws.close();
          });
          stream.on('close', (code, reason) => {
            logger.info({ code, reason: reason.toString() }, `stream close`);
            ws.close();
          });
          stream.on('message', (data, isBinary) => {
            if (isBinary) {
              ws.send(data);
            }
            else {
              let message = JSON.parse(data.toString());
              this.handleMessage(message, (...args) => this.transcript(...args));
            }
          });
        }
      }
    });
    ws.on('error', (err) => {
      state = 'error';
      logger.error({ err }, `received socket error ${err.message}`);
      stream?.close();
    });
    ws.on('close', (code, reason) => {
      state = 'closed';
      logger.info({ code, reason }, `socket close`);
      stream?.close();
    });

  }

  async handleMessage(message, callback) {
    let { logger } = this;
    logger.info({ message }, 'LLM message received for handler that has no message processor');
  }

  async transcript({ callId: callIdOverride, type, data }, isFinal = true, delta = false) {
    let { callId, logger, agent: { userId, organisationId } = {} } = this;
    callId = callIdOverride || callId;
    this.provisionalLog = this.provisionalLog || {};
    logger.debug({ callId, type, data, isFinal, delta, provisionalLog: this.provisionalLog[type] }, 'transcript');
    if (this.provisionalLog[type]) {
      Object.assign(this.provisionalLog[type], { type, data: delta ? this.provisionalLog[type].data + data : data, isFinal });
      logger.debug({ provisionalLog: this.provisionalLog[type] }, 'saving update');
      this.provisionalLog[type].save();
      isFinal && delete this.provisionalLog[type];
    }
    else {
      logger.debug({ callId, type, data }, 'creating new');
      let transaction = await TransactionLog.create({
        userId, organisationId, callId, type, data, isFinal
      });
      !isFinal && (this.provisionalLog[type] = transaction);
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