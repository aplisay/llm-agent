require('dotenv').config();
const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
const defaultLogger = require('../logger');
const Handler = require('./handler');
const LiveKitModel = require('../models/livekit');

class Livekit extends Handler {
  static name = 'livekit';
  static description = 'Livekit';


  static get models() {
    return [LiveKitModel];
  }

  static needKey = { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL };

  static voices = (async (logger) => {
    return {
      OpenAI: {
        'any': [
          {
            name: 'alloy',
            description: 'Alloy',
            gender: 'female'
          },
          {
            name: 'echo',
            description: 'Echo',
            gender: 'female'
          },

          {
            name: 'fable',
            description: 'Fable - transatlantic',
            gender: 'female'
          },
          {
            name: 'onyx',
            description: 'Onyx',
            gender: 'male'
          },
          {
            name: 'nova',
            description: 'Nova',
            gender: 'female'
          },
          {
            name: 'shimmer',
            description: 'Shimmer',
            gender: 'female'
          }
        ]
      }
    };
  })(defaultLogger);

  async activate(instanceId) {
    let { logger } = this;
    logger.info({ instanceId, req: 'none' }, 'creating room');
    try {
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
      logger.info({ id: instanceId, livekit }, 'In band call started');
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
    logger.info({ callId }, 'Inband call ending');

    try {
      instance && await instance.destroy({ logging: logger.info });
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
