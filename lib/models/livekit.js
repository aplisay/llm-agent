require('dotenv').config();



const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
const { Agent, Instance } = require('../database');
const UUIDV4 = require('uuid').v4;
const Llm = require('./llm');

if (!process.env.ULTRAVOX_API_KEY) {
  throw new Error('No ultravox api key, set ULTRAVOX_API_KEY in server environment ;');
}


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

  static allModels = [
    ["livekit/GPT-4o", "GPT-4o Audio"],
  ];


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
  constructor({ model }) {
    super(...arguments);
    this.model = model || Livekit.allModels[0][0];
    this.logger.info({ thisPrompt: this.prompt }, 'NEW Livekit agent');
  }

  set prompt(newPrompt) {
    this._prompt = newPrompt;
    let system = this.gpt?.messages?.find(m => m.role === 'system');
    system && (system.content = this._prompt);
  }


  get prompt() {
    return this._prompt;
  }

  set options(newOptions) {
    this._options = newOptions;
  }
  get options() {
    return this._options;
  }


  async startInband() {
    let { id = UUIDV4(), instanceId = UUIDV4(), prompt, options: { temperature, voice }, logger, model, functions, keys } = this;


    try {
      logger.info({ Agent, Instance }, 'Starting inband call');
      // Add rows to the database for this agent and create a new instance
      this.agent = Agent.build({ id, prompt, options: { temperature, voice }, logger, modelName: model, functions, keys });
      await this.agent.save();
      this.instance = Instance.build({ id: instanceId, agentId: id, type: 'lk_realtime' });
      await this.instance.save();
      // Generate participant token
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
      logger.info({ self: this }, 'In band call started');
      return { id: instanceId, socket: LIVEKIT_URL, livekit };

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
    logger.info({ callId }, 'Inband call ending');

    try {
      instance && await instance.destroy({logging: logger.info});
      agent && await agent.destroy({ logging: logger.info });
      logger.info({ agent, instance }, 'Inband call ended');
    }
    catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Inband call teardown: ${error.message}`);
    }

  }

}


module.exports = Livekit;
