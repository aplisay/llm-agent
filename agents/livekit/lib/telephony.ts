import { SipClient } from "livekit-server-sdk";
import { SIPMediaEncryption, SIPTransport } from "@livekit/protocol";
import logger from "./logger.js";
import { getPhoneNumbers } from "./api-client.js";

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_SIP_USERNAME, LIVEKIT_SIP_PASSWORD } = process.env;

export async function transferParticipant(
  roomName: string, 
  participant: string, 
  transferTo: string, 
  aplisayId: string,
  registrar?: string | null,
  transport?: string | null,
  callerId?: string | null,
  originatingCallId?: string | null,
): Promise<any> {
  logger.info({ roomName, participant, transferTo, registrar, transport }, "transfer participant initiated");

  // If registrar is provided, construct SIP URI for registration endpoint
  let transferUri = `tel:${transferTo}`;

  if (registrar) {
    // Extract host from registrar (e.g., "sip:provider.example.com:5060" -> "provider.example.com:5060")
    const registrarHost = (registrar as string).replace(/^sip:/i, '').replace(/^tel:/i, '');
    transferUri = `sip:${transferTo}@${registrarHost}`;
    if (transport) {
      transferUri += `;transport=${transport as string}`;
    }
  }

  const sipTransferOptions = {
    playDialtone: false,
    headers: {
      "Refer-Sub": "false",
      "Supported": "norefersub",
      ...(callerId ? { "X-Aplisay-Origin-Caller-Id": callerId } : {}),
      ...(originatingCallId ? { "X-Aplisay-Call-Id": originatingCallId } : {}),
    },
  };

  const sipClient = new SipClient(LIVEKIT_URL!, LIVEKIT_API_KEY!, LIVEKIT_API_SECRET!);
  logger.info({ transferUri, participant }, 'transfer URI');
  const result = await sipClient.transferSipParticipant(roomName, participant, transferUri, sipTransferOptions);
  logger.info({ result, transferUri }, 'transfer participant result');
  return result;
}

/**
 * Maps transport string to SIPTransport enum
 */
function mapTransportToSIPTransport(transport: string | null | undefined): SIPTransport {
  if (!transport) {
    return SIPTransport.SIP_TRANSPORT_TCP; // Default
  }
  const transportLower = transport.toLowerCase();
  switch (transportLower) {
    case 'udp':
      return SIPTransport.SIP_TRANSPORT_UDP;
    case 'tcp':
      return SIPTransport.SIP_TRANSPORT_TCP;
    case 'tls':
      return SIPTransport.SIP_TRANSPORT_TLS;
    default:
      logger.warn({ transport }, 'Unknown transport, defaulting to TCP');
      return SIPTransport.SIP_TRANSPORT_TCP;
  }
}

/**
 * Finds or creates an outbound SIP trunk for a registration endpoint.
 * Trunk name format: "Registration Trunk <IP address> <Transport>".
 * Media encryption is always SIP_MEDIA_ENCRYPT_ALLOW (SRTP when offered).
 * @param registrar - Registrar URI (e.g., "sip:provider.example.com:5060")
 * @param transport - Transport protocol (udp, tcp, tls)
 * @returns The SIP trunk ID
 */
async function findOrCreateRegistrationTrunk(
  registrar: string,
  transport: string | null | undefined,
): Promise<string> {
  const sipClient = new SipClient(
    LIVEKIT_URL!,
    LIVEKIT_API_KEY!,
    LIVEKIT_API_SECRET!
  );

  // Extract IP address/hostname from registrar (e.g., "sip:provider.example.com:5060" -> "provider.example.com")
  // Remove any existing port number
  let registrarHost = registrar.replace(/^sips?:/i, '').replace(/^tel:/i, '');
  // Remove port if present (e.g., "provider.example.com:5060" -> "provider.example.com")
  registrarHost = registrarHost.split(':')[0];
  
  // Normalize transport for trunk name
  const transportName = (transport || 'tcp').toUpperCase();
  
  const trunkName = `Registration Trunk ${registrarHost} ${transportName}`;

  const port = (transportName === 'TLS') ? 5071 : 5070;

  // For B2BUA gateway connections, use port 5070
  const b2buaAddress = `${registrarHost}:${port}`;

  logger.info(
    { trunkName, registrarHost, b2buaAddress, transport },
    "Finding or creating registration trunk",
  );

  // List existing outbound trunks
  const outboundSipTrunks = await sipClient.listSipOutboundTrunk();
  let registrationTrunk = outboundSipTrunks.find(
    (t) => t.name === trunkName
  );

  if (registrationTrunk) {
    logger.info({ trunkName, sipTrunkId: registrationTrunk.sipTrunkId }, 'Found existing registration trunk');
    return registrationTrunk.sipTrunkId;
  }

  // Trunk doesn't exist, create it
  logger.info({ trunkName, registrarHost, b2buaAddress, transport }, 'Creating new registration trunk');

  // Get phone numbers for the trunk (required parameter)
  const phoneNumbersData = await getPhoneNumbers('livekit');
  const phoneNumbers = phoneNumbersData.map((p: any) => `+${p.number}`).concat('00000');

  // Map transport string to SIPTransport enum
  const sipTransport = mapTransportToSIPTransport(transport);

  // Create the trunk pointing to the B2BUA gateway on port 5070
  registrationTrunk = await sipClient.createSipOutboundTrunk(
    trunkName,
    b2buaAddress, // Outbound URI is the B2BUA gateway address with port 5070
    phoneNumbers,
    {
      transport: sipTransport,
      authUsername: LIVEKIT_SIP_USERNAME!,
      authPassword: LIVEKIT_SIP_PASSWORD!,
      mediaEncryption: SIPMediaEncryption.SIP_MEDIA_ENCRYPT_ALLOW,
    },
  );

  logger.info({ trunkName, sipTrunkId: registrationTrunk.sipTrunkId }, 'Created registration trunk');
  return registrationTrunk.sipTrunkId;
}

/**
 * Bridges a participant into a room (for blind transfers)
 * @param roomName - Name of the room to bridge into
 * @param bridgeTo - Phone number to dial
 * @param aplisayId - Aplisay trunk ID (optional, not needed for registration-originated calls)
 * @param callerId - Caller ID to use for the call
 * @param originCallerId - Original caller ID
 * @param registrationOriginated - Inbound from a registration endpoint, or outbound originate with registration UUID (worker sets B2BUA from registration b2buaId)
 * @param b2buaGatewayIp - B2BUA edge: sipHXLkRealIp on inbound, or PhoneRegistration.b2buaId for registration outbound originate
 * @param b2buaGatewayTransport - sipHXLkTransport on inbound, or registration options.transport (default tcp) for originate
 * @param registrationEndpointId - Registration UUID for X-Aplisay-PhoneRegistration
 * @param originatingCallId - Platform call id for tracing headers
 * @returns The created SIP participant
 */
export async function bridgeParticipant(
  roomName: string,
  bridgeTo: string,
  aplisayId: string,
  callerId: string,
  originCallerId: string,
  registrationOriginated: boolean = false,
  b2buaGatewayIp: string | null | undefined = null,
  b2buaGatewayTransport: string | null | undefined = null,
  registrationEndpointId: string | null | undefined = null,
  originatingCallId: string | null | undefined = null,
): Promise<any> {
  const sipClient = new SipClient(
    LIVEKIT_URL!,
    LIVEKIT_API_KEY!,
    LIVEKIT_API_SECRET!
  );

  const origin = callerId.replace(/^0/, "44").replace(/^(?!\+)/, "+");
  const destination = bridgeTo.replace(/^0/, "44").replace(/^(?!\+)/, "+");

  if (registrationOriginated && b2buaGatewayIp && registrationEndpointId) {
    logger.info(
      { roomName, b2buaGatewayIp, b2buaGatewayTransport, registrationEndpointId, destination },
      "bridging participant through B2BUA gateway for registration-originated call"
    );

    // Find or create a trunk for this B2BUA gateway
    const registrationTrunkId = await findOrCreateRegistrationTrunk(
      b2buaGatewayIp,
      b2buaGatewayTransport,
    );

    // For registration endpoints, we dial the destination number directly
    // The trunk is configured to route to the registrar, and we include the registration endpoint ID in headers
    const sipParticipantOptions = {
      participantIdentity: 'sip-outbound-call',
      headers: {
        "X-Aplisay-PhoneRegistration": registrationEndpointId, // Include registration endpoint ID in headers
        "X-Aplisay-Origin-Caller-Id": originCallerId || 'unknown',
        ...(originatingCallId ? { "X-Aplisay-Call-Id": originatingCallId } : {})
      },
      participantName: 'Aplisay Bridged Transfer',
      fromNumber: '00000',
      krispEnabled: true,
      waitUntilAnswered: true
    };

    logger.info({ roomName, destination, origin, callerId, sipParticipantOptions, registrationTrunkId }, "bridge participant initiated (registration endpoint)");

    const newParticipant = await sipClient.createSipParticipant(
      registrationTrunkId,
      bridgeTo, // Use phone number, trunk routes to registrar
      roomName,
      sipParticipantOptions
    );
    logger.info({ newParticipant, registrationTrunkId }, 'new participant result (registration endpoint)');
    return newParticipant;
  }

  if (!aplisayId?.length) {
    throw new Error('No inbound trunk or inbound trunk does not support bridging');
  }

  const outboundSipTrunks = await sipClient.listSipOutboundTrunk();
  const outboundSipTrunk = outboundSipTrunks.find(t => t.name === 'Aplisay Outbound');

  if (!outboundSipTrunk) {
    throw new Error('No livekit outbound SIP trunk found');
  }

  // Outbound trunk to use for the call
  const sipParticipantOptions = {
    participantIdentity: 'sip-outbound-call',
    headers: {
      'X-Aplisay-Trunk': aplisayId,
      'X-Aplisay-Origin-Caller-Id': originCallerId || 'unknown',
      ...(originatingCallId ? { "X-Aplisay-Call-Id": originatingCallId } : {})
    },
    participantName: 'Aplisay Bridged Transfer',
    fromNumber: origin,
    krispEnabled: true,
    waitUntilAnswered: true
  };

  logger.info({ roomName, destination, origin, callerId, sipParticipantOptions }, "bridge participant initiated (trunk-based)");

  const newParticipant = await sipClient.createSipParticipant(
    outboundSipTrunk.sipTrunkId,
    bridgeTo,
    roomName,
    sipParticipantOptions
  );
  logger.info({ newParticipant }, 'new participant result (trunk-based)');
  return newParticipant;
}

/**
 * Dials a transfer target into a consultation room
 * @param consultRoomName - Name of the consultation room
 * @param destination - Phone number to dial (or registration endpoint ID if registrationOriginated)
 * @param effectiveCallerId - Caller ID to use for the call
 * @param effectiveAplisayId - Aplisay trunk ID (optional)
 * @param transferTargetIdentity - Identity for the transfer target participant
 * @param registrationOriginated - Same semantics as bridgeParticipant (inbound registration leg or outbound originate)
 * @param b2buaGatewayIp - sipHXLkRealIp or registration b2buaId
 * @param b2buaGatewayTransport - sipHXLkTransport or registration options.transport
 * @param registrationEndpointId - Registration UUID for X-Aplisay-PhoneRegistration
 * @param originatingCallId - Platform call id for tracing headers
 * @returns The created SIP participant
 */
export async function dialTransferTargetToConsultation(
  consultRoomName: string,
  destination: string,
  effectiveCallerId: string,
  effectiveAplisayId: string | null | undefined,
  transferTargetIdentity: string = "transfer-target",
  registrationOriginated: boolean = false,
  b2buaGatewayIp: string | null | undefined = null,
  b2buaGatewayTransport: string | null | undefined = null,
  registrationEndpointId: string | null | undefined = null,
  callerId: string | null | undefined = null,
  originatingCallId: string | null | undefined = null,
): Promise<any> {
  const sipClient = new SipClient(
    LIVEKIT_URL!,
    LIVEKIT_API_KEY!,
    LIVEKIT_API_SECRET!
  );

  const origin = effectiveCallerId.replace(/^0/, "44").replace(/^(?!\+)/, "+");

  if (registrationOriginated && b2buaGatewayIp && registrationEndpointId) {
    logger.info(
      { consultRoomName, b2buaGatewayIp, b2buaGatewayTransport, registrationEndpointId, destination },
      "dialing transfer target through B2BUA gateway for registration-originated call"
    );

    // Find or create a trunk for this B2BUA gateway
    const registrationTrunkId = await findOrCreateRegistrationTrunk(
      b2buaGatewayIp,
      b2buaGatewayTransport,
    );
    
    // Format destination number
    const destinationFormatted = destination.replace(/^0/, "44").replace(/^(?!\+)/, "+");

    // For registration endpoints, we dial the destination number directly
    // The trunk is configured to route to the registrar, and we include the registration endpoint ID in headers
    const transferTargetParticipant = await sipClient.createSipParticipant(
      registrationTrunkId,
      destinationFormatted, // Use phone number, trunk routes to registrar
      consultRoomName,
      {
        participantIdentity: transferTargetIdentity,
        headers: {
          "X-Aplisay-PhoneRegistration": registrationEndpointId, // Include registration endpoint ID in headers
          "X-Aplisay-Origin-Caller-Id": callerId || 'unknown',
          ...(originatingCallId ? { "X-Aplisay-Call-Id": originatingCallId } : {})
        },
        participantName: "Transfer Target",
        fromNumber: origin,
        krispEnabled: true,
        waitUntilAnswered: true,
      }
    );

    logger.info({ transferTargetParticipant, consultRoomName, destinationFormatted, registrationEndpointId, registrationTrunkId }, "transfer target dialed through registrar trunk with registration endpoint ID");
    return transferTargetParticipant;
  }

  // For trunk-based calls, use the outbound SBC as before
  const outboundSipTrunks = await sipClient.listSipOutboundTrunk();
  const outboundSipTrunk = outboundSipTrunks.find(
    (t) => t.name === "Aplisay Outbound"
  );

  if (!outboundSipTrunk) {
    throw new Error("No livekit outbound SIP trunk found");
  }

  const destinationFormatted = destination.replace(/^0/, "44").replace(/^(?!\+)/, "+");

  const transferTargetParticipant = await sipClient.createSipParticipant(
    outboundSipTrunk.sipTrunkId,
    destinationFormatted,
    consultRoomName,
    {
      participantIdentity: transferTargetIdentity,
      headers: {
        "X-Aplisay-Trunk": effectiveAplisayId || '',
        "X-Aplisay-Origin-Caller-Id": callerId || 'unknown',
        ...(originatingCallId ? { "X-Aplisay-Call-Id": originatingCallId } : {})
      },
      participantName: "Transfer Target",
      fromNumber: origin,
      krispEnabled: true,
      waitUntilAnswered: true,
    }
  );

  logger.info({ transferTargetParticipant, consultRoomName, destination }, "transfer target dialed into consultation room");
  return transferTargetParticipant;
} 