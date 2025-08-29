const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
import { Agent, Instance } from '../database.js';
import { v4 as UUIDV4 } from 'uuid';
import Llm from './llm.js';

const LOCATION = {
  path: 'PARAMETER_LOCATION_PATH',
  query: 'PARAMETER_LOCATION_QUERY',
  body: 'PARAMETER_LOCATION_BODY',
  default: 'PARAMETER_LOCATION_UNSPECIFIED'
};

/**
 * Implements the LLM class against the Livekit model
 *
 * 
 * @param {Object} logger Pino logger instance
 * @param {string} user a unique user ID
 * @param {string} prompt The initial (system) chat prompt
 * @param {Object} options options
 * @param {number} options.temperature The LLM temperature
 *                 See model documentation
 * @class Livekit
 * @extends {Llm}
 */
class Livekit extends Llm {

  static handler = 'lk_realtime';

  static allModels = [
    ["openai", "gpt-4o-realtime", "OpenAI GPT-4o Realtime"],
    ["ultravox", "ultravox-70b", "Ultravox 70B via Livekit"],
  ].map(([vendor, name, description]) => ([`${vendor}/${name}`, description]));

  static get needKey() {
    return { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL };
  }

  /**
   * Livekit supports function calling only with 70B model   *
   * @static 
   * @memberof OpenAi
   */
  static supportsFunctions = (model) => true;
  // Livekit is an audio model so no STT and TTS is builtin etc
  static audioModel = true;


  /**
   * Creates an instance of Livekit.
   * @memberof OpenAi
   */
  constructor({ modelName } = {}) {
    super(...arguments);
    this.model = modelName || Livekit.allModels[0][0];
    this.logger.debug({ thisPrompt: this.prompt }, 'NEW Livekit agent');
  }



}


export default Livekit;
