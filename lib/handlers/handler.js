import defaultLogger from '../logger.js';
import crypto from 'crypto';
import Voices from '../voices/index.js';
import { Instance, Agent, TransactionLog, User, Organisation } from '../database.js';
import { resolveListenerTransferOverrides } from '../listener-transfer-overrides.js';
import WebSocket from 'ws';
/**
 * Superclass for the handler interface which implements a runtime handler for one or more models
 *
 * @class Handler
 */
export default class Handler {

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
  // Supports the transfer_agent builtin: in-call handover to another agent definition
  static hasAgentTransfer = false;
  // Supports the subagent builtin: invocation of a `text` type agent as a function call
  static hasSubagent = false;
  // Supports the send_dtmf builtin: play RFC 4733 (out-of-band) DTMF digits over a SIP call
  static hasDtmf = false;
  // Supports options.stt.aux: an auxiliary ("second opinion") STT run over the caller's
  // audio alongside the primary stack, logged as `user-aux` and metered as `stt-aux`.
  // Needs a worker that owns the caller's media independently of the model stack.
  static hasAuxStt = false;
  // The Agent.type implemented by this handler: 'interactive-audio' (default) or 'text'
  static agentType = 'interactive-audio';

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
    // Handler-level env gate: a whole handler *family* drops out of the roster
    // when its transport credentials are unset (e.g. no LIVEKIT_* → no livekit
    // models, no JAMBONZ_* → no jambonz models). This is what lets us ship a
    // pipecat-only or livekit-only instance. It is distinct from the per-model
    // `canLoad` filter below, which gates individual LLM providers on their own
    // API keys. Handlers with no `needKey` (e.g. `text`) are unaffected.
    if (!this.canLoad.ok) {
      return [];
    }
    if (!this._availableModels) {
      this._availableModels = this.models
        // canLoad is an {ok, need} OBJECT — filtering on the object itself was
        // always truthy, which listed providers whose API key env was unset
        // (and constructing those could fall back to the wrong provider's key).
        .filter((implementation) => implementation.canLoad.ok)
        .reduce((o, implementation) => o.concat(
          implementation.allModels.map((row) => {
            const [name, description, flags = {}] =
              row.length >= 3 && typeof row[2] === 'object' && row[2] !== null && !Array.isArray(row[2])
                ? row
                : [row[0], row[1], {}];
            return {
              name: `${this.name}:${name}`,
              supportsFunctions: implementation.supportsFunctions(name),
              supportsMcp: implementation.supportsMcp(name),
              hasTelephony: this.hasTelephony,
              hasWebRTC: this.hasWebRTC,
              description,
              implementation,
              audioModel: flags.audioModel ?? implementation.audioModel,
              voiceStack: flags.voiceStack,
              requiresSttTts: flags.pipeline === true || flags.voiceStack === 'pipeline',
            };
          })
        ), []);
    }
    return this._availableModels;
  }

  static parseName(modelName = '') {
    // Syntax of a modelname is handler:provider/model e.g. jambonz:openai/gpt-4o
    // If handler not explicitly provided then default to class name
    const match = modelName.matchAll(/(([a-z0-9-_]*):)*([^\/]+)\/(.*)/g);
    if (match) {
      const [[, , handler = this.name, provider, model]] = [...match];
      const implementation = provider && this.models?.find((m) => (m.name.toLowerCase() === provider || m.aliases?.some((a) => a.toLowerCase() === provider)));  
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
    let instance = await Instance.findByPk(instanceId, { include: [Agent, User, Organisation] });
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

    // Getter-applied values (get({plain:true})), not raw dataValues: JSONB
    // columns holding at-rest encrypted material (keys, options.recording.key)
    // must reach the implementation in usable form. An agent that is already a
    // plain materialised object passes through unchanged.
    const agentValues = typeof agent?.get === 'function' ? agent.get({ plain: true }) : agent;
    this.model = implementation && new implementation({ ...agentValues, logger });
    logger.debug({ agent, handler, implementation, model: this.model }, 'NEW handler created');
    Object.assign(this, { agent, implementation });
    this.logger.debug({ handler: this.name, implementation, model, logger: this.logger }, 'client created');
  }

  async activate({ number, id, options = {}, websocket = false } = {}) {
    let { streamLog = false, metadata, recording, agentLimit } = options;
    let { agent, logger } = this;
    if (!this.agent.id) {
      throw new Error('No current agent');
    }
    if (!this.constructor.hasWebSocket && websocket) {
      throw new Error('This handler does not support websocket');
    }
    let { id: agentId, userId, organisationId } = agent;
    let progressPath;
    logger.debug({ agent, streamLog, options, number, id }, `activating agent ${agent.id} with number ${number} or id ${id} or websocket ${websocket}`);
    // Listener-level transfer overrides: validated (and label-resolved)
    //  against this agent before the instance exists, so a bad map can never
    //  reach a live call. Each stored field wholesale-replaces the same-named
    //  agent option in the workers.
    const { bridgedTransferToAgent, bridgedTransferTranscribe, dtmfTimeout } =
      await resolveListenerTransferOverrides({
        agent,
        Handler: this.constructor,
        bridgedTransferToAgent: options.bridgedTransferToAgent,
        bridgedTransferTranscribe: options.bridgedTransferTranscribe,
        dtmfTimeout: options.dtmfTimeout,
      });
    // Ultravox uses jambonz for SIP ingress so uses numbers from Jambonz pool
    let type = this.constructor.name === 'ultravox' ? 'jambonz' : this.constructor.name;
    (number || id) && await this.preWarmup();


    let instance = this.instance = await Instance.build({
      agentId: agent.id,
      userId,
      organisationId,
      type,
      agentLimit,
      streamLog,
      websocket,
      metadata,
      recording,
      bridgedTransferToAgent,
      bridgedTransferTranscribe,
      dtmfTimeout
    });
    let prefix = Buffer.from(`instance:${instance.id}:`);
    // Generate a random key for the instance, this is used to authenticate the agent
    // to the instance and to prevent replay attacks on the progress socket server
    let buffer = Buffer.concat([prefix, crypto.randomBytes(48)]);
    instance.key = buffer.toString('base64');
    await instance.save();

    let allocated;
    let allocatedId;
    if (number) {
      allocated = this.number = await instance.linkNumber(type, number, organisationId);
      if (!allocated) {
        throw new Error(`No number available for agent ${agentId} (requested ${number})`);
      }
    } else if (id) {
      allocatedId = await instance.linkRegistration(type, id, organisationId);
      if (!allocatedId) {
        throw new Error(`No registration available for agent ${agentId} (requested ${id})`);
      }
    }
    progressPath = `/progress/${instance.id}`;
    this.progress = { send: () => (null) };
    this.logger.debug({ instance, id: instance.id, number: allocated, registrationId: allocatedId, socket: progressPath }, 'activation result');
    return { id: instance.id, number: allocated, registrationId: allocatedId, key: instance.key, socket: progressPath };


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
