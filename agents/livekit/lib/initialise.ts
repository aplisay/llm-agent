import dotenv from 'dotenv';
import { SipClient } from 'livekit-server-sdk';
import { SIPHeaderOptions, SIPTransport } from '@livekit/protocol';
import * as loggerModule from '../agent-lib/logger.js';
import { getPhoneNumbers } from './api-client.js';

dotenv.config();

const logger = loggerModule.default;

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
  LIVEKIT_SIP_OUTBOUND, LIVEKIT_SIP_USERNAME, LIVEKIT_SIP_PASSWORD } = process.env;

  logger.debug({ LIVEKIT_SIP_OUTBOUND, LIVEKIT_SIP_USERNAME, LIVEKIT_SIP_PASSWORD }, 'LIVEKIT_SIP_OUTBOUND');


export async function setupSIPClients(): Promise<any> {
  const sipClient = new SipClient(process.env.LIVEKIT_URL!, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);

  const phoneNumbersData = await getPhoneNumbers('livekit');
  const phoneNumbers = phoneNumbersData.map((p: any) => `+${p.number}`).concat('00000');
  logger.info({ phoneNumbers }, 'Phone numbers');
  if (!phoneNumbers.length) {
    logger.info('No phone numbers found');
    return { phoneNumbers: [], dispatchRule: {} };
  }
  const inboundSipTrunks = await sipClient.listSipInboundTrunk();
  let inboundSipTrunk = inboundSipTrunks.find(t => t.name === 'Aplisay');
  if (!inboundSipTrunk) {
    inboundSipTrunk = await sipClient.createSipInboundTrunk(
      'Aplisay',
      phoneNumbers,
      {
        includeHeaders: SIPHeaderOptions.SIP_X_HEADERS
      }
    );
    logger.info({ inboundSipTrunk }, 'SIP trunk created');
  }
  else {
    logger.info({ inboundSipTrunk }, 'SIP trunk found');
    // sync phone numbers from our database to livekit
    if (inboundSipTrunk.numbers.length !== phoneNumbers.length || inboundSipTrunk.numbers.some((n: string) => !phoneNumbers.includes(n))) {
      inboundSipTrunk = await sipClient.updateSipInboundTrunk(inboundSipTrunk.sipTrunkId, {
        name: 'Aplisay',
        numbers: phoneNumbers,
        includeHeaders: SIPHeaderOptions.SIP_X_HEADERS,
        krispEnabled: true,
      } as any);
    }
    logger.info({ inboundSipTrunk }, 'SIP trunk updated');
  }
  if (!inboundSipTrunk) {
    throw new Error('Livekit SIP trunk not found and can\'t be created');
  }

  const outboundSipTrunks = await sipClient.listSipOutboundTrunk();
  let outboundSipTrunk = outboundSipTrunks.find(t => t.name === 'Aplisay Outbound');
  outboundSipTrunk && await sipClient.deleteSipTrunk(outboundSipTrunk.sipTrunkId);
  outboundSipTrunk = null as any;
  logger.debug({ outbound: LIVEKIT_SIP_OUTBOUND }, 'outboundSipTrunk');
  if (!outboundSipTrunk) {
    outboundSipTrunk = await sipClient.createSipOutboundTrunk(
      "Aplisay Outbound",
      LIVEKIT_SIP_OUTBOUND!,
      phoneNumbers,
      {
        transport: SIPTransport.SIP_TRANSPORT_TCP,
        authUsername: LIVEKIT_SIP_USERNAME!,
        authPassword: LIVEKIT_SIP_PASSWORD!
      }
    );
    logger.info({ outboundSipTrunk }, 'SIP outbound trunk created');
  }
  else {
    logger.info({ outboundSipTrunk }, 'SIP outbound trunk found');
  }

  const dispatchRules = await sipClient.listSipDispatchRule();
  let dispatchRule = dispatchRules.find(d => d.name === 'Aplisay');
  if (!dispatchRule) {
    dispatchRule = await sipClient.createSipDispatchRule({
      type: 'individual',
      roomPrefix: 'call'
    },
      {
        name: 'Aplisay',
        roomConfig: {
          agents: [{
            agentName: 'realtime'
          } as any]
        } as any
      }
    );
    logger.info({ dispatchRule }, 'SIP dispatch rule created');
  }
  if (!dispatchRule) {
    throw new Error('Livekit SIP dispatch rule not found and can\'t be created');
  }

  return { phoneNumbers, dispatchRule };
}

export async function runSetup(): Promise<void> {
  setupSIPClients().then(({ phoneNumbers, dispatchRule }) => {
    logger.info({ phoneNumbers, dispatchRule }, 'SIP clients setup');
    logger.info('SIP clients setup, exiting');
    process.exit(0);
  });
} 