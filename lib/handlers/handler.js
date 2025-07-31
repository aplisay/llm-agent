import { randomBytes } from 'crypto';
import defaultLogger from '../logger.js';
import Voices from '../voices/index.js';
import { Instance, Agent, TransactionLog } from '../database.js';
import WebSocket from 'ws';
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
  static hasWebSocket = false;
  static hasTransfer = false;

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
    console.log({ modelName }, 'modelNAme');
    const match = modelName.matchAll(/(([a-z0-9-_]*):)*([^\/]+)\/(.*)/g);
    if (match) {
      const [[, , handler = this.name, provider, model]] = [...match];
      const implementation = provider && this.models?.find((m) => m.name.toLowerCase() === provider);  
      return { handler, provider, implementation, model };
    }
    return {};
  }

  static getHandler(modelName, list, models) {
    let { handler } = this.parseName(modelName, models);
    return handler && list.find((m) => m.name === handler);
  }

  // Default is all voices we have configured, but this can be overridden
  static get voices() {
    return new Voices(defaultLogger).availableVoices;
  }

  static async fromInstance(instanceId, list, models, logger = defaultLogger) {
    let instance = await Instance.findByPk(instanceId, { include: Agent });
    let handler = instance && this.getHandler(instance.agent.model, list, models);
    return handler && new handler({ agent: instance.agent, instance, logger });
  }

  constructor({ agent, instance, logger = defaultLogger, ...rest }) {
    Object.assign(this, { agent, instance, logger, ...rest });
    Handler.liveInstances[instance.id] = this;
  }

  async activate({ number, options = {}, websocket = false } = {}) {
    let { instance, agent, logger } = this;
    logger.debug({ instance: instance.id, agent: agent.id, number, options }, 'activating agent');
    if (number) {
      await instance.linkNumber(this.constructor.name.toLowerCase(), number, agent.organisationId);
    }
    if (websocket) {
      this.ws = websocket;
    }
    return instance;
  }

  async preWarmup() {
    // Override in subclasses if needed
  }

  async setStreamUrl(url) {
    let { instance, logger } = this;
    logger.debug({ url }, 'setting stream url');
    await instance.update({ streamUrl: url });
    this.streamUrl = url;
  }

  async handleUpdates(ws) {
    let { instance, logger } = this;
    let state = 'connecting';
    logger.debug({ id: instance.id }, 'websocket connection for updates');
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        logger.debug({ data: data.length }, 'received binary data');
      }
      else {
        let message = JSON.parse(data.toString());
        logger.debug({ message }, 'received message');
        this.handleMessage(message, (...args) => this.transcript(...args));
      }
    });
    ws.on('error', (err) => {
      state = 'error';
      logger.error({ err }, `received socket error ${err.message}`);
    });
    ws.on('close', (code, reason) => {
      state = 'closed';
      logger.info({ code, reason }, `socket close`);
    });
  }

  async handleAudio(ws) {
    let { instance, logger } = this;
    let state = 'connecting';
    let stream;
    let outBuffer = [];
    let { callId, streamUrl } = this;
    logger.debug({ id: instance.id }, 'websocket connection for audio');
    ws.on('message', (data, isBinary) => {
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

export default Handler;