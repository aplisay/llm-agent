const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
import defaultLogger from '../logger.js';
import Handler from './handler.js';
import LiveKitModel from '../models/livekit.js';
import Ultravox from './ultravox.js';

class Livekit extends Handler {
  static name = 'livekit';
  static description = 'Livekit';
  static hasWebRTC = true;
  static hasTelephony = true;
  static hasTransfer = true;

  static get models() {
    return [LiveKitModel];
  }

  static needKey = { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL };

  static voices = (async (logger) => {
    return {
      ...(await Ultravox.voices),
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

  static async outbound({ instance, callerId, calledId, metadata, aplisayId }) {
    const logger = defaultLogger;
    const { id: instanceId } = instance;
    
    logger.debug({ instanceId, callerId, calledId, metadata }, 'originating outbound LiveKit call');
    
    try {
      // Create a unique room name for this outbound call
      const roomName = `outbound-${instanceId}-${Date.now()}`;
      
      // Dispatch the agent with outbound metadata
      const { AgentDispatchClient } = await import('livekit-server-sdk');
      const client = new AgentDispatchClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
      
      const dispatchResult = await client.createDispatch(roomName, 'realtime', {
        metadata: JSON.stringify({
          callerId,
          calledId,
          instanceId,
          aplisayId,
          outbound: true
        })
      });

      logger.debug({ dispatchResult, roomName }, 'LiveKit agent dispatched for outbound call');
      
      return {
        success: true,
        roomName,
        dispatchResult
      };
      
    } catch (error) {
      logger.error({ error, instanceId, callerId, calledId }, 'Failed to originate outbound LiveKit call');
      throw new Error(`Outbound call origination failed: ${error.message}`);
    }
  }

  async join() {

    let { logger, instance: {id: instanceId}} = this;
    logger.debug({ instanceId, req: 'none' }, 'creating room');
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
      logger.debug({ livekit }, 'In band call started');
      return { livekit };

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
    const { RoomConfiguration, RoomAgentDispatch } = await import("@livekit/protocol");
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
    at.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName: 'realtime',
          metadata: JSON.stringify(userInfo)
        }),
      ],
    });
    return at.toJwt();
  }

  async destroy() {

    let { callId, logger, agent, instance } = this;
    logger.debug({ callId }, 'Inband call ending');

    try {
      instance && await instance.destroy({ logging: logger.debug });
      agent && await agent.destroy({ logging: logger.debug });
      logger.debug({ agent, instance }, 'Inband call ended');
    }
    catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Inband call teardown: ${error.message}`);
    }

  }

}


export default Livekit;
