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
  async activate(instanceId) {
    let { logger } = this;

    try {
      let modelData = this.model.modelData;
      logger.debug(modelData, 'Starting inband call');
      let res = super.activate(instanceId);
      let {
        data: { callId, ended, joinUrl }
      } = await api.post('calls', modelData);
      if (ended || !callId?.length || !joinUrl?.length) {
        throw new Error('API call failed');
      }
      this.callId = callId;
      logger.debug({ self: this }, 'In band call started');
      return { ...res, ultravox: { joinUrl } };

    }
    catch (error) {
      console.error(error);
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

}

module.exports = Ultravox;