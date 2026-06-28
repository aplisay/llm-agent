// Validation/normalization for request-supplied values before they are
// interpolated into FreeSWITCH ESL command strings (client.bgapi()).
//
// The call-control API builds ESL command strings by plain string
// concatenation: originate channel-variable blocks (`{k=v,k=v}`), dial strings
// (`sofia/...`), and uuid_* commands. A value containing an ESL-significant
// character — space, `,`, `{`, `}`, `'`, `"`, `&`, `;`, newline — can inject
// additional channel variables, break out of the `{...}` block, or append extra
// dialplan applications to the dial string (e.g. `... &bridge(x) &lua(...)`).
//
// These values are attacker-influenceable: `destination` ultimately derives
// from the LLM `transfer` tool-call argument (steered by the live conversation
// with the remote caller), and `callerId`/`callerIdOverride` can derive from
// the inbound caller's SIP From. So every interpolated field is validated here
// with a strict allowlist (not a denylist) before it reaches any bgapi string.
//
// The Python worker boundary (call_session / freeswitch_gateway) should also
// validate, but this is the last line of defence and the single point every
// caller — current and future — funnels through.

import type { OriginateBody, TransferBody } from "./call-api.js";

/** Raised when a request value fails validation. The route maps this to 400. */
export class ValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

// --- Allowlist patterns (anchored; in JS `$` does not match before a trailing
// newline without the `m` flag, so these reject embedded/trailing newlines). ---

/** E.164-ish PSTN number: optional leading `+`, 1–20 digits. */
const E164_RE = /^\+?[0-9]{1,20}$/;

/** Strict SIP/SIPS URI: scheme, userpart, `@host`, optional `:port`, optional
 *  `;param[=value]` repeated. Deliberately narrow — no spaces/quotes/braces. */
const SIP_URI_RE =
  /^sips?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+(?::\d{1,5})?(?:;[A-Za-z0-9.+_-]+(?:=[A-Za-z0-9.+_-]+)?)*$/;

/** Caller ID: E.164 number or short alphanumeric sender id. No ESL metachars. */
const CALLER_ID_RE = /^\+?[A-Za-z0-9._-]{1,64}$/;

/** Opaque token (call id, trunk id, gateway name, registration id). */
const TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** RFC-4122-shaped UUID (channel/peer uuids). */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Transport keyword (udp/tcp/tls/ws/wss). */
const TRANSPORT_RE = /^[A-Za-z]{2,4}$/;

/** Host or host:port (b2bua authority, scheme already stripped). */
const HOST_RE = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

function asString(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError(field, `${field} must be a string`);
  }
  return value;
}

/**
 * A transfer/originate destination: an E.164 number or a strict SIP URI.
 * Rejects anything carrying ESL/dial-string metacharacters.
 */
export function validateDestination(value: unknown): string {
  const s = asString("destination", value);
  if (E164_RE.test(s) || SIP_URI_RE.test(s)) return s;
  throw new ValidationError(
    "destination",
    `invalid destination ${JSON.stringify(s)} (expected E.164 digits or a sip: URI)`,
  );
}

/** A caller-id number / sender id. */
export function validateCallerId(field: string, value: unknown): string {
  const s = asString(field, value);
  if (CALLER_ID_RE.test(s)) return s;
  throw new ValidationError(
    field,
    `invalid ${field} ${JSON.stringify(s)} (expected digits/+ or a short alphanumeric id)`,
  );
}

/** An opaque identifier token (call id, trunk id, gateway name, etc). */
export function validateToken(field: string, value: unknown): string {
  const s = asString(field, value);
  if (TOKEN_RE.test(s)) return s;
  throw new ValidationError(
    field,
    `invalid ${field} ${JSON.stringify(s)} (expected [A-Za-z0-9._-], max 128)`,
  );
}

/** A channel/peer UUID. */
export function validateUuid(field: string, value: unknown): string {
  const s = asString(field, value);
  if (UUID_RE.test(s)) return s;
  throw new ValidationError(field, `invalid ${field} ${JSON.stringify(s)} (expected a UUID)`);
}

/** A b2bua gateway authority (host or host:port; a sip: scheme is stripped). */
export function validateHost(field: string, value: unknown): string {
  const s = asString(field, value).replace(/^sips?:/i, "").trim();
  if (HOST_RE.test(s)) return asString(field, value);
  throw new ValidationError(field, `invalid ${field} ${JSON.stringify(value)} (expected host[:port])`);
}

/** A SIP transport keyword. */
export function validateTransport(field: string, value: unknown): string {
  const s = asString(field, value);
  if (TRANSPORT_RE.test(s)) return s;
  throw new ValidationError(field, `invalid ${field} ${JSON.stringify(s)} (expected udp/tcp/tls)`);
}

/**
 * Validate + normalize an originate request body. Returns a body whose
 * interpolated fields are all guaranteed safe to concatenate into a bgapi
 * string. Throws {@link ValidationError} (→ HTTP 400) on the first bad field.
 */
export function validateOriginateBody(body: OriginateBody): OriginateBody {
  const safe: OriginateBody = {
    ...body,
    destination: validateDestination(body.destination),
    callerId: validateCallerId("callerId", body.callerId),
    callId: validateToken("callId", body.callId),
  };
  if (body.channelUuid != null && body.channelUuid !== "") {
    safe.channelUuid = validateUuid("channelUuid", body.channelUuid);
  }
  if (body.aplisayId != null && body.aplisayId !== "") {
    safe.aplisayId = validateToken("aplisayId", body.aplisayId);
  }
  if (body.gateway != null && body.gateway !== "") {
    safe.gateway = validateToken("gateway", body.gateway);
  }
  if (body.b2buaGatewayIp != null && body.b2buaGatewayIp !== "") {
    safe.b2buaGatewayIp = validateHost("b2buaGatewayIp", body.b2buaGatewayIp);
  }
  if (body.b2buaGatewayTransport != null && body.b2buaGatewayTransport !== "") {
    safe.b2buaGatewayTransport = validateTransport(
      "b2buaGatewayTransport",
      body.b2buaGatewayTransport,
    );
  }
  if (body.registrationEndpointId != null && body.registrationEndpointId !== "") {
    safe.registrationEndpointId = validateToken(
      "registrationEndpointId",
      body.registrationEndpointId,
    );
  }
  return safe;
}

/**
 * Validate + normalize a transfer request body. `callerIdOverride` is optional
 * and may be the empty string (the bridge path tolerates an empty CLI).
 */
export function validateTransferBody(body: TransferBody): TransferBody {
  if (body.operation !== "refer" && body.operation !== "bridge") {
    throw new ValidationError(
      "operation",
      `invalid operation ${JSON.stringify(body.operation)} (expected "refer" or "bridge")`,
    );
  }
  const safe: TransferBody = {
    ...body,
    destination: validateDestination(body.destination),
  };
  if (body.callerIdOverride != null && body.callerIdOverride !== "") {
    safe.callerIdOverride = validateCallerId("callerIdOverride", body.callerIdOverride);
  }
  if (body.aplisayCallId != null && body.aplisayCallId !== "") {
    safe.aplisayCallId = validateToken("aplisayCallId", body.aplisayCallId);
  }
  return safe;
}
