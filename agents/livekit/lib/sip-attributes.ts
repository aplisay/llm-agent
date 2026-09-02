/**
 * Reading LiveKit SIP participant attributes.
 *
 * LiveKit surfaces SIP participant attributes in **dotted** form —
 * `sip.phoneNumber`, `sip.trunkPhoneNumber`, `sip.hostname`, and (for INVITE
 * X- headers, when the trunk is created with `includeHeaders=SIP_X_HEADERS`,
 * see initialise.ts) `sip.h.x-<name>` with the header name lowercased. That is
 * the authoritative, lossless form, and it is what the deployed workers
 * actually receive.
 *
 * Some SDK/deploy paths have historically surfaced the same values under
 * camelCased keys instead (`sipPhoneNumber`, `sipHXAplisayTrunk`, …), which is
 * the form the inbound routing originally read — and read *exclusively*, so it
 * resolved everything to `undefined` against a dotted-key participant and the
 * call failed with "no instance found for inbound call".
 *
 * Accept either form, preferring the dotted key. See also
 * `collectSipInviteHeaders` in worker.ts, which applies the same
 * dotted-preferred/camel-fallback rule to the full X- header set.
 */

/** Dotted (authoritative) and camelCase (legacy) key for each attribute we route on. */
export const SIP_ATTRIBUTE_KEYS = {
  /** Number the caller dialled — the trunk's DID. */
  calledNumber: ["sip.trunkPhoneNumber", "sipTrunkPhoneNumber"],
  /** Calling party number. */
  callerNumber: ["sip.phoneNumber", "sipPhoneNumber"],
  /** Aplisay trunk id stamped by the SBC. */
  aplisayTrunk: ["sip.h.x-aplisay-trunk", "sipHXAplisayTrunk"],
  /** The number the caller dialled, when the B2BUA carries it in a header
   *  rather than the Request-URI (a registration trunk: LiveKit admits the
   *  call on the trunk's fixed number, so the DID rides here). */
  aplisayCalled: ["sip.h.x-aplisay-called", "sipHXAplisayCalled"],
  /** Phone-registration endpoint id, when the leg came from a registration. */
  phoneRegistration: [
    "sip.h.x-aplisay-phoneregistration",
    "sipHXAplisayPhoneregistration",
  ],
  /** Registrar hostname of the inbound leg. */
  sipHostname: ["sip.hostname", "sipHostname"],
  /** B2BUA gateway host/IP, used to route outbound/transfer legs back. */
  lkRealIp: ["sip.h.x-lk-real-ip", "sipHXLkRealIp"],
  /** B2BUA gateway transport. */
  lkTransport: ["sip.h.x-lk-transport", "sipHXLkTransport"],
  /** A-leg media encryption hint; drives B-leg trunk media policy. */
  lkMediaEncryption: ["sip.h.x-lk-media-encryption", "sipHXLkMediaEncryption"],
} as const satisfies Record<string, readonly [string, string]>;

export type SipAttributeName = keyof typeof SIP_ATTRIBUTE_KEYS;

/**
 * Read one attribute by dotted key, falling back to the camelCase alias.
 * Empty strings are treated as absent so a blank header doesn't mask a
 * usable value under the other spelling.
 */
export function readSipAttribute(
  attributes: Record<string, string> | undefined | null,
  dottedKey: string,
  camelKey: string,
): string | undefined {
  if (!attributes) return undefined;

  const exact = attributes[dottedKey] ?? attributes[camelKey];
  if (exact != null && exact !== "") return exact;

  // LiveKit lowercases X- header names, but tolerate paths that don't.
  const wanted = dottedKey.toLowerCase();
  for (const [key, value] of Object.entries(attributes)) {
    if (key.toLowerCase() === wanted && value != null && value !== "") {
      return value;
    }
  }
  return undefined;
}

/** Read a known routing attribute, accepting either key format. */
export function sipAttribute(
  attributes: Record<string, string> | undefined | null,
  name: SipAttributeName,
): string | undefined {
  const [dottedKey, camelKey] = SIP_ATTRIBUTE_KEYS[name];
  return readSipAttribute(attributes, dottedKey, camelKey);
}
