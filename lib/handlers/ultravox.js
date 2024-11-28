require('dotenv').config();
const axios = require('axios');
const Handler = require('./handler.js');
const UltravoxModel = require('../models/ultravox');
const { ULTRAVOX_API_KEY } = process.env;

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
    let { logger, instance: { number }, model: { modelData } } = this;

    try {
      logger.debug({ modelData, websocket }, 'Starting inband call');
      websocket && Object.assign(modelData, {
        medium: {
          serverWebSocket: {
            inputSampleRate: 8000,
            outputSampleRate: 8000,
            clientBufferSizeMs: 60
          }
        },
        "initiator": "INITIATOR_USER"
      });
      let {
        data: { callId, ended, joinUrl }
      } = await api.post('calls', modelData);
      if (ended || !callId?.length || !joinUrl?.length) {
        throw new Error('API call failed');
      }
      this.callId = callId;
      logger.debug({ joinUrl }, 'In band call started');
      return { ultravox: { joinUrl } };
    }
    catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Call setup: ${error.message}`);
    }


  }

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
    logger.debug({ callId, message, type }, 'Inband message');
    switch (type) {
      case 'transcript':
        let { role, text, delta, final: isFinal } = message;
        post({ type: role, data: text || delta }, isFinal, delta);
        break;
      case 'debug':
        let debug = message && message.type && message.message;
        if (debug && debug.startsWith('LLM response: \nTool calls:')) {
          let [[, method, body]] = debug.matchAll(/FunctionCall\(name='([^']*)'.*args='([^']*)'.*\)/ig).toArray() || [[]];
          post({ type: rest_callout, data: { method, body, url: "" } });
        }
        else if (debug && debug.startsWith('Tool call complete. Result: ')) {
          let [[, body, name]] = debug.matchAll(/.*role: MESSAGE_ROLE_TOOL_RESULT[\s\S]*text: "(.*)"[\s\S]*tool_name: "(.*)"/ig).toArray() || [[]];
          post({ type: function_results, data: [{ name, input: [], result: body.replace(/\\/g, '') }] });
        }
        break;
      default:
        break;
    }
  }

}

module.exports = Ultravox;