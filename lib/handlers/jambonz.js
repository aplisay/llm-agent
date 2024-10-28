require('dotenv').config();
const axios = require('axios');
const Handler = require('./handler');
const Claude = require('../models/anthropic');
const OpenAi = require('../models/openai');
const Groq = require('../models/groq');
const Palm2 = require('../models/palm2');
const Gemini = require('../models/gemini');
const Jambonz = require('../jambonz');
const Voices = require('../voices');
const models = require('../models');
const defaultLogger = require('../logger');

const { JAMBONZ_API_KEY, JAMBONZ_SERVER } = process.env;



/**
 * Implements the Handler class for Jambonz
 *
 * 
 * @param {Object} logger Pino logger instance
 * @param {string} user a unique user ID
 * @param {string} prompt The initial (system) chat prompt
 * @param {Object} options options
 * @param {number} options.temperature The LLM temperature
 *                 See model documentation
 * @class Ultravox
 * @extends {Llm}
 */
class JambonzHandler extends Handler {

  static name = 'jambonz';
  static description = 'Jambonz';
  static get models() {
    return [
      Claude, OpenAi, Groq, Palm2, Gemini
    ];
  }
  static needKey = { JAMBONZ_API_KEY, JAMBONZ_SERVER };

  // Jambonz may have a subset of voice service providers configured for TTS
  static voices = (async (logger) => {
    let jambonz = new Jambonz(logger, 'voices');
    let voices = await Handler.voices
    let filtered = (await jambonz.getCredentials())
      .filter(provider => provider.use_for_tts && provider.tts_tested_ok && provider.vendor)
      .reduce((o, { vendor }) => ({ ...o, [vendor]: voices[vendor] }), []);
    logger.debug({ allVoices: voices, jambonzVoices: filtered }, 'Voices');
    return filtered;
  })(defaultLogger);
}


module.exports = JambonzHandler;
