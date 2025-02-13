require('dotenv').config();
const axios = require('axios');
const Handler = require('./handler.js');
const UltravoxModel = require('../models/ultravox');
const { Call } = require('../database.js');
const { ULTRAVOX_API_KEY, JAMBONZ_AGENT_NAME } = process.env;

const api = axios.create({
  baseURL: 'https://api.ultravox.ai/api/',
  headers: {
    'X-API-Key': process.env.ULTRAVOX_API_KEY
  }
});

class Ultravox extends Handler {
  static name = 'ultravox';
  static description = 'Ultravox';
  static hasTelephony = true;
  static hasWebRTC = true;


  static get models() {
    return [
      UltravoxModel
    ];
  }
  static needKey = { ULTRAVOX_API_KEY };

  static get voices() {
    return api.get('/voices').then(res => (
      {
        ultravox: {
          'en-US': res.data.results.map(({ name, description }) => (
            {
              name,
              description: name.length < 20 ? `${name} - ${description}` : description,
              gender: 'unknown',
            }
          ))
        }
      }
    ));
  }


  async join(websocket) {
    let { agent: { id: agentId, userId, organisationId }, logger, instance: { id: instanceId }, model: { modelData } } = this;

    try {
      logger.debug({ self: this, modelData, websocket }, 'Starting inband call');
      websocket && Object.assign(modelData, {
        medium: {
          serverWebSocket: {
            inputSampleRate: 8000,
            outputSampleRate: 8000,
            clientBufferSizeMs: 60
          }
        },
        "firstSpeaker": "FIRST_SPEAKER_AGENT"
      });
      let {
        data: { callId: platformCallId, ended, joinUrl }
      } = await api.post('calls', modelData);
      if (ended || !platformCallId?.length || !joinUrl?.length) {
        throw new Error('API call failed');
      }
      let callerId = 'WebRTC';
      let calledId = callerId;
      logger.debug({
        agentId, instanceId, userId, callerId,
        calledId, organisationId, platformCallId, platform: 'ultravox'
      }, 'creating placeholder call record');
      const { id: callId } = await Call.create({
        agentId,
        instanceId,
        userId,
        organisationId,
        callerId,
        calledId,
        platformCallId,
        platform: 'ultravox'
      });
      joinUrl = new URL(joinUrl);
      websocket && joinUrl.searchParams.append('experimentalMessages', 'debug');
      this.callId = callId;
      logger.debug({ joinUrl }, 'In band call started');
      return { ultravox: { joinUrl: joinUrl.toString() }, callId };
    }
    catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Call setup: ${error.message}`);
    }
  }

  async preWarmup() {
    let { logger } = this;
    try {
      logger.debug('Prewarming jambonz handler');
      await axios.get(`https://${JAMBONZ_AGENT_NAME}/ping`);
      logger.debug('Prewarming jambonz handler done');
    }
    catch (error) {
      logger.debug({ message: error?.message }, 'handler prewarm error (expected)');
    }
  }

  // TODO: implement
  async warmup() {
    // TODO: implement
  }

  // TODO: implement
  async shutdown() {
    // TODO: implement
  }

  // TODO: implement

  async destroy() {

    let { callId, logger } = this;
    logger.debug({ callId }, 'Inband call ending');

    try {
      if (!callId) {
        await api.delete(`calls/${callId}`);
      }
    }
    catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Inband call teardown: ${error.message}`);
    }

  }

  async handleMessage(message, post) {
    let { callId, logger } = this;
    let { type } = message;
    switch (type) {
      case 'transcript':
        let { role, text, delta, final: isFinal } = message;
        await post({ callId, type: role, data: text || delta }, isFinal, !!delta);
        break;
      case 'debug':
        let debug = message && message.type && message.message;
        try {
          if (debug && debug.startsWith('LLM response: \nTool calls:')) {
            let res = [...debug.matchAll(/FunctionCall\(name='([^']*)'.*args='([^']*)'.*\)/ig) || []];
            let [[, method, body]] = res;
            logger.debug({ method, body, res, debug: JSON.stringify(debug) }, 'tool call debug');
            method && body && post({ type: 'rest_callout', data: { method, body, url: "" } });
          }
          else if (debug && debug.startsWith('Tool call complete. Result: ')) {
            let res = [...(debug.matchAll(/.*role: MESSAGE_ROLE_TOOL_RESULT[\s\S]*text: "(.*)"[\s\S]*tool_name: "(.*)"/ig) || [])];
            let [[, body, name]] = res;
            logger.debug({ res, body, name, debug: JSON.stringify(debug) }, 'tool result debug');
            body && post({ type: 'function_results', data: [{ name, input: [], result: body.replace(/\\/g, '') }] });
          }
        }
        catch (error) {
          logger.error({ error }, `parse error ${error.message}`);
        }
        break;
      default:
        break;
    }
  }

  static ROLE_MAP = {
    'MESSAGE_ROLE_USER': 'user',
    'MESSAGE_ROLE_AGENT': 'agent',
    'MESSAGE_ROLE_TOOL_CALL': 'rest_callout',
    'MESSAGE_ROLE_TOOL_RESULT': 'function_results',
    'MESSAGE_ROLE_UNSPECIFIED': 'error'
  };

  async callEnded(ultravoxCall, call) {
    let { logger } = this;
    let { callId, created: startedAt, ended: endedAt } = ultravoxCall;
    try {
      call.set({ startedAt, endedAt });
      call.duration = call.startedAt && call.endedAt && call.endedAt.valueOf() - call.startedAt.valueOf();
      await call.save();
      if (callId) {
        this.callId = call.id;
        let apiCall = `calls/${callId}/messages`;
        do {
          let { data: { next, results } } = await api.get(apiCall);
          logger.debug({ next, results, callId }, 'got messages');
          apiCall = next;
          for (var message of results){
            message.role = Ultravox.ROLE_MAP[message.role];
            if (message.role === 'function_results') {
              message.text = JSON.stringify([{ name: message.toolName, input: {}, result: message.text }]);
            }
            if (message.role === 'rest_callout') {
              message.text = JSON.stringify({method: '', url: message.toolName, body: message.text});
            }
            message.role && await this.handleMessage({ ...message, type: 'transcript' }, this.transcript.bind(this));
          };
        }
        while (apiCall);
        logger.debug({ call }, 'callEnded');
      }
    }
    catch (error) {
      logger.error({ error }, `callEnded error ${error.message}`);
    }
  }
}

module.exports = Ultravox;