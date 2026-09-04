import dotenv from "dotenv";
import { SipClient } from "livekit-server-sdk";
import { SIPHeaderOptions, SIPTransport, SIPMediaEncryption } from "@livekit/protocol";
import logger from "./logger.js";
import { getPhoneNumbers, setPhoneNumberProvisioned } from "./api-client.js";
import { livekitCredentials } from "./livekit-constants.js";

dotenv.config();

const { LIVEKIT_SIP_OUTBOUND, LIVEKIT_SIP_USERNAME, LIVEKIT_SIP_PASSWORD } = process.env;


export async function setupSIPClients(): Promise<any> {
  const sipClient = new SipClient(...livekitCredentials());

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
      "Aplisay",
      phoneNumbers,
      {
        // ALL headers (not just X-*) so the From header lands in the
        // `sip.h.from` participant attribute: its display-name is surfaced as
        // metadata.aplisay.callerIdName (lib/sip-attributes.ts). The X- header
        // collection for aplisay.sipHeaders still picks only sip.h.x-*.
        includeHeaders: SIPHeaderOptions.SIP_ALL_HEADERS,
        mediaEncryption: SIPMediaEncryption.SIP_MEDIA_ENCRYPT_ALLOW,
      },
    );
    logger.info({ inboundSipTrunk }, 'SIP trunk created');
  }
  else {
    logger.info({ inboundSipTrunk }, 'SIP trunk found');
    // sync phone numbers from our database to livekit, and bring a trunk
    // created before the switch to SIP_ALL_HEADERS up to the current option
    if (inboundSipTrunk.numbers.length !== phoneNumbers.length
      || inboundSipTrunk.numbers.some((n: string) => !phoneNumbers.includes(n))
      || inboundSipTrunk.includeHeaders !== SIPHeaderOptions.SIP_ALL_HEADERS) {
      inboundSipTrunk = await sipClient.updateSipInboundTrunk(inboundSipTrunk.sipTrunkId, {
        name: 'Aplisay',
        numbers: phoneNumbers,
        includeHeaders: SIPHeaderOptions.SIP_ALL_HEADERS,
        krispEnabled: true,
        mediaEncryption: SIPMediaEncryption.SIP_MEDIA_ENCRYPT_ALLOW,
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

  // At this point, phoneNumbers have been synced to LiveKit trunks.
  // Mark only unprovisioned LiveKit phone numbers as provisioned in the platform.
  try {
    const unprovisionedNumbers = phoneNumbersData.filter((p: any) => !p.provisioned);
    for (const p of unprovisionedNumbers) {
      // phoneNumbersData entries have numbers without '+'; PATCH normalised number
      await setPhoneNumberProvisioned(p.number, true);
    }
  } catch (err) {
    logger.error({ err }, 'Failed to mark some phone numbers as provisioned');
  }

  return { phoneNumbers, dispatchRule };
}

export async function runSetup(): Promise<void> {
  // Awaited and caught, not fire-and-forget: an unhandled rejection here printed a
  // bare stack and left the exit code to Node, which is the wrong shape for a
  // one-shot command an operator runs by hand and reads the result of.
  try {
    const { phoneNumbers, dispatchRule } = await setupSIPClients();
    logger.info({ phoneNumbers, dispatchRule }, 'SIP clients setup');
    logger.info('SIP clients setup, exiting');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'SIP client setup failed');
    process.exit(1);
  }
}
