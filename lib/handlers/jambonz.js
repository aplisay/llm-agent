import Handler from './handler.js';
import Claude from '../models/anthropic.js';
import OpenAi from '../models/openai.js';
import Groq from '../models/groq.js';
import Gemini from '../models/gemini.js';
import Jambonz from '../jambonz.js';
import defaultLogger from '../logger.js';

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
  static hasWebRTC = false;
  static hasTelephony = true;




  static get models() {
    return [
      Claude, OpenAi, Groq, Gemini
    ];
  }
  static needKey = { JAMBONZ_API_KEY, JAMBONZ_SERVER };

  // Jambonz may have a subset of voice service providers configured for TTS
  static voices = (async (logger) => {
    const jambonz = new Jambonz(logger, 'voices');
    const voices = await Handler.voices
    const filtered = (await jambonz.getCredentials())
      .filter(provider => provider.use_for_tts && provider.tts_tested_ok && provider.vendor)
      .reduce((o, { vendor }) => ({ ...o, [vendor]: voices[vendor] }), []);
    return filtered;
  })(defaultLogger);
}


export default JambonzHandler;
