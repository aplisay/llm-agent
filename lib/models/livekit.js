require('dotenv').config();

const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
const { Agent, Instance } = require('../database');
const UUIDV4 = require('uuid').v4;
const Llm = require('./llm');

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
;

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


  async activate(instanceId) {
    let { logger } = this;
    logger.debug({ instanceId, req:'none' }, 'creating room');
    try{
      const participantIdentity = `${instanceId}`;
      const participantToken = await Livekit.createParticipantToken(
        {
          identity: participantIdentity,
          metadata: participantIdentity
        },
        `agent-${instanceId}`,
      );
      if (LIVEKIT_URL === undefined) {
        throw new Error("LIVEKIT_URL is not defined");
      }

      // Return connection details
      const livekit = {
        serverUrl: LIVEKIT_URL,
        roomName: "voice_assistant_room",
        participantToken: participantToken,
        participantName: participantIdentity,
      };
      logger.debug({ id: instanceId, livekit }, 'In band call started');
      return { id: instanceId, livekit };

    }
    catch (error) {
      console.error(error);
      throw new Error(`Call setup: ${error.message}`);
    }
  }



  static async createParticipantToken(
    userInfo, roomName
  ) {
    const { AccessToken } = await import("livekit-server-sdk");
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, userInfo);
    at.ttl = "5m";
    const grant = {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    };
    at.addGrant(grant);
    return at.toJwt();
  }

  async destroy() {

    let { callId, logger, agent, instance } = this;
    logger.debug({ callId }, 'Inband call ending');

    try {
      instance && await instance.destroy({logging: logger.debug});
      agent && await agent.destroy({ logging: logger.debug });
      logger.debug({ agent, instance }, 'Inband call ended');
    }
    catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Inband call teardown: ${error.message}`);
    }

  }

}


module.exports = Livekit;
