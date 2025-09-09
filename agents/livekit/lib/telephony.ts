import { SipClient } from 'livekit-server-sdk';
import * as loggerModule from '../agent-lib/logger.js';

const logger = loggerModule.default;

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

export async function transferParticipant(roomName: string, participant: string, transferTo: string, aplisayId: string): Promise<any> {
  logger.info({ roomName, participant, transferTo }, "transfer participant initiated");

  const sipTransferOptions = {
    playDialtone: false
  };

  const sipClient = new SipClient(LIVEKIT_URL!, LIVEKIT_API_KEY!, LIVEKIT_API_SECRET!);
  const result = await sipClient.transferSipParticipant(roomName, participant, transferTo, sipTransferOptions);
  logger.info({ result }, 'transfer participant result');
  return result;
}

export async function bridgeParticipant(roomName: string, bridgeTo: string, aplisayId: string, callerId: string): Promise<any> {

  if (!aplisayId?.length) {
    throw new Error('No inbound trunk or inbound trunk does not support bridging');
  }

  const sipClient = new SipClient(LIVEKIT_URL!,
    LIVEKIT_API_KEY!,
    LIVEKIT_API_SECRET!);

  const outboundSipTrunks = await sipClient.listSipOutboundTrunk();
  let outboundSipTrunk = outboundSipTrunks.find(t => t.name === 'Aplisay Outbound');
  const { sipTrunkId } = outboundSipTrunk!;

  if (!outboundSipTrunk) {
    throw new Error('No livekit outbound SIP trunk found');
  }
  const origin = callerId.replace(/^0/, "44").replace(/^(?!\+)/, "+");
  const destination = bridgeTo.replace(/^0/, "44").replace(/^(?!\+)/, "+");

  // Outbound trunk to use for the call
  const sipParticipantOptions = {
    participantIdentity: 'sip-outbound-call',
    headers: {
      'X-Aplisay-Trunk': aplisayId
    },
    participantName: 'Aplisay Bridged Transfer',
    fromNumber: origin,
    krispEnabled: true,
    waitUntilAnswered: true
  };

  logger.info({ roomName, destination, origin, callerId, sipParticipantOptions }, "bridge participant initiated");

  const newParticipant = await sipClient.createSipParticipant(
    sipTrunkId,
    destination,
    roomName,
    sipParticipantOptions
  );
  logger.info({ newParticipant }, 'new participant result');
  return newParticipant;
} 