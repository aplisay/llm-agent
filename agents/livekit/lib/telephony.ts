import { SipClient } from "livekit-server-sdk";
import { SIPMediaEncryption, SIPHeaderOptions, SIPTransport } from "@livekit/protocol";
import logger from "./logger.js";
import { getPhoneNumbers } from "./api-client.js";

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_SIP_USERNAME, LIVEKIT_SIP_PASSWORD } = process.env;

/**
 * The DB `Trunk.id` of our chargeable public outbound trunk — stamped onto
 * `Call.outboundTrunkId` for CARRIED (non-registration) outbound legs so the
 * server's destination-billing gate (`Trunk.chargeable`) fires. A
 * registration-originated leg egresses the customer's own B2BUA (their PBX, never
 * our carrier), so it is NOT stamped. If `APLISAY_OUTBOUND_TRUNK_ID` is unset the
 * helper returns undefined → nothing is destination-charged (fail-safe).
 */
export function chargeableOutboundTrunkId(registrationOriginated?: boolean): string | undefined {
  if (registrationOriginated) return undefined;
  return process.env.APLISAY_OUTBOUND_TRUNK_ID || undefined;
}

export async function transferParticipant(
  roomName: string, 
  participant: string, 
  transferTo: string, 
  aplisayId: string,
  registrar?: string | null,
  transport?: string | null,
  callerId?: string | null,
  originatingCallId?: string | null,
  // RFC 3891 dialog identifier ("call-id;to-tag=...;from-tag=...") of the leg the
  // referred party should replace, for the consultative (attended) finalise so the
  // caller's endpoint replaces the consultation dialog instead of ringing the
  // target a second time. On the B2BUA path this is the gateway-facing consult
  // dialog, reflected to us via X-Aplisay-Refer-Replaces; the B2BUA sofia profile
  // has proxy-refer=true, so it relays this REFER (?Replaces intact) upstream to
  // the carrier. See finaliseConsultativeTransfer and aplisay-b2bua refer_reflect.lua.
  replaces?: string | null,
): Promise<any> {
  logger.info({ roomName, participant, transferTo, registrar, transport, replaces }, "transfer participant initiated");

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

  // Attended transfer: embed Replaces in the Refer-To URI so the referred party
  // replaces the existing (consultation) dialog. tel: URIs cannot carry a
  // Replaces param, so upgrade to a sip: URI targeting the same number.
  if (replaces) {
    if (transferUri.startsWith("tel:")) {
      transferUri = `sip:${transferTo}`;
    }
    transferUri += `?Replaces=${encodeURIComponent(replaces)}`;
  }

  // NB: we deliberately do NOT send `Refer-Sub: false` / `Supported: norefersub`.
  // Keeping the implicit RFC 3515 REFER subscription means the far end
  // (carrier/PBX) NOTIFYs us the transfer outcome as a sipfrag, so LiveKit can
  // observe the real result of the referred INVITE instead of only inferring
  // success from the caller leg leaving the room. This is what surfaces, e.g., a
  // carrier accepting the REFER ("202") and then failing the ?Replaces swap —
  // which otherwise looks identical to "still in progress" until we time out.
  const sipTransferOptions = {
    playDialtone: false,
    headers: {
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
 * Trunk name format: "Registration Trunk <IP address> <Transport>" for
 * encryption-allowed trunks, with a " (plain RTP)" suffix for the
 * unencrypted variant. Two distinct named trunks are maintained so that the
 * media-encryption policy can be selected per call based on whether the
 * A-leg media is encrypted: offering SRTP to a plain-RTP-only endpoint
 * (e.g. some Wildix configurations) is rejected with a 603 Decline.
 * @param registrar - Registrar URI (e.g., "sip:provider.example.com:5060")
 * @param transport - Transport protocol (udp, tcp, tls)
 * @param allowEncryption - When true, create/use a trunk that offers SRTP
 *   (SIP_MEDIA_ENCRYPT_ALLOW); when false, use a trunk that forces plain RTP
 *   (SIP_MEDIA_ENCRYPT_DISABLE). Defaults to true to preserve prior behaviour.
 * @returns The SIP trunk ID
 */
async function findOrCreateRegistrationTrunk(
  registrar: string,
  transport: string | null | undefined,
  allowEncryption: boolean = true,
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

  // The plain-RTP variant gets a distinct name so both trunks can coexist;
  // the encryption-allowed name is kept unchanged for backward compatibility.
  const encryptionSuffix = allowEncryption ? '' : ' (plain RTP)';
  const trunkName = `Registration Trunk ${registrarHost} ${transportName}${encryptionSuffix}`;

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
      mediaEncryption: allowEncryption
        ? SIPMediaEncryption.SIP_MEDIA_ENCRYPT_ALLOW
        : SIPMediaEncryption.SIP_MEDIA_ENCRYPT_DISABLE,
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
 * @param aLegEncrypted - Whether the A-leg media is encrypted (SRTP). Drives
 *   registration-trunk media-encryption policy selection. Defaults to true to
 *   preserve prior behaviour (offer SRTP) when the signal is unavailable.
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
  aLegEncrypted: boolean = true,
  registrationUsername: string | null | undefined = null,
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
      { roomName, b2buaGatewayIp, b2buaGatewayTransport, registrationEndpointId, destination, aLegEncrypted },
      "bridging participant through B2BUA gateway for registration-originated call"
    );

    // Find or create a trunk for this B2BUA gateway. Select the media-encryption
    // policy based on the A-leg: only offer SRTP to the B-leg when the A-leg is
    // itself encrypted, otherwise force plain RTP to avoid 603 Decline from
    // plain-RTP-only endpoints.
    const registrationTrunkId = await findOrCreateRegistrationTrunk(
      b2buaGatewayIp,
      b2buaGatewayTransport,
      aLegEncrypted,
    );

    // For registration endpoints, we dial the destination number directly
    // The trunk is configured to route to the registrar, and we include the registration endpoint ID in headers
    const sipParticipantOptions = {
      participantIdentity: 'sip-outbound-call',
      headers: {
        "X-Aplisay-PhoneRegistration": registrationEndpointId, // Include registration endpoint ID in headers
        // A number on a registration trunk keeps its trunk identity too.
        ...(aplisayId ? { "X-Aplisay-Trunk": aplisayId } : {}),
        "X-Aplisay-Origin-Caller-Id": originCallerId || 'unknown',
        ...(originatingCallId ? { "X-Aplisay-Call-Id": originatingCallId } : {})
      },
      participantName: 'Aplisay Bridged Transfer',
      // Present the registration's own trunk username (the A-leg's To-user /
      // SIP extension) as the calling number toward the gateway, rather than
      // the placeholder. Avoids 603 Decline from PBXs that reject an unknown
      // calling number. Falls back to the placeholder when unavailable.
      fromNumber: registrationUsername || '00000',
      krispEnabled: true,
      waitUntilAnswered: true
    };

    logger.info({ roomName, destination, origin, callerId, sipParticipantOptions, registrationTrunkId, registrationUsername }, "bridge participant initiated (registration endpoint)");

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
 * @param aLegEncrypted - Whether the A-leg media is encrypted (SRTP). Drives
 *   registration-trunk media-encryption policy selection. Defaults to true to
 *   preserve prior behaviour (offer SRTP) when the signal is unavailable.
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
  aLegEncrypted: boolean = true,
  registrationUsername: string | null | undefined = null,
): Promise<any> {
  const sipClient = new SipClient(
    LIVEKIT_URL!,
    LIVEKIT_API_KEY!,
    LIVEKIT_API_SECRET!
  );

  const origin = effectiveCallerId.replace(/^0/, "44").replace(/^(?!\+)/, "+");

  if (registrationOriginated && b2buaGatewayIp && registrationEndpointId) {
    logger.info(
      { consultRoomName, b2buaGatewayIp, b2buaGatewayTransport, registrationEndpointId, destination, aLegEncrypted },
      "dialing transfer target through B2BUA gateway for registration-originated call"
    );

    // Find or create a trunk for this B2BUA gateway. Select the media-encryption
    // policy based on the A-leg: only offer SRTP to the B-leg when the A-leg is
    // itself encrypted, otherwise force plain RTP to avoid 603 Decline from
    // plain-RTP-only endpoints.
    const registrationTrunkId = await findOrCreateRegistrationTrunk(
      b2buaGatewayIp,
      b2buaGatewayTransport,
      aLegEncrypted,
    );
    
    // For registration endpoints, we dial the destination number directly
    // The trunk is configured to route to the registrar, and we include the registration endpoint ID in headers
    const transferTargetParticipant = await sipClient.createSipParticipant(
      registrationTrunkId,
      destination, // Dial exactly as specified in the transfer request; trunk routes to the registrar
      consultRoomName,
      {
        participantIdentity: transferTargetIdentity,
        headers: {
          "X-Aplisay-PhoneRegistration": registrationEndpointId, // Include registration endpoint ID in headers
          ...(effectiveAplisayId ? { "X-Aplisay-Trunk": effectiveAplisayId } : {}),
          "X-Aplisay-Origin-Caller-Id": callerId || 'unknown',
          ...(originatingCallId ? { "X-Aplisay-Call-Id": originatingCallId } : {})
        },
        participantName: "Transfer Target",
        // Present the registration's own trunk username (e.g. the A-leg's
        // To-user / SIP extension) as the calling number toward the gateway,
        // rather than the placeholder CLI. Some PBXs (e.g. Wildix) 603-Decline
        // an outbound/transfer call whose calling number is unrecognised. Fall
        // back to the previous behaviour when the username is unavailable.
        fromNumber: registrationUsername || origin,
        krispEnabled: true,
        waitUntilAnswered: true,
        // Map all SIP response headers (incl. To/From dialog tags + Call-ID and
        // the B2BUA-reflected X-Aplisay-Refer-Replaces) to sip.h.* attributes so
        // the consultative REFER can build an RFC 3891 Replaces from the consult
        // leg. See startConsultativeTransfer / finaliseConsultativeTransfer.
        includeHeaders: SIPHeaderOptions.SIP_ALL_HEADERS,
      }
    );

    logger.info({ transferTargetParticipant, consultRoomName, destination, registrationEndpointId, registrationTrunkId, registrationUsername }, "transfer target dialed through registrar trunk with registration endpoint ID");
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

  const transferTargetParticipant = await sipClient.createSipParticipant(
    outboundSipTrunk.sipTrunkId,
    destination,
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
      // Map all SIP response headers (incl. To/From dialog tags + Call-ID) to
      // sip.h.* attributes so the consultative REFER can build an RFC 3891
      // Replaces from the consult leg. See finaliseConsultativeTransfer.
      includeHeaders: SIPHeaderOptions.SIP_ALL_HEADERS,
    }
  );

  logger.info({ transferTargetParticipant, consultRoomName, destination }, "transfer target dialed into consultation room");
  return transferTargetParticipant;
} 