/**
 * Reading LiveKit SIP participant attributes.
 *
 * LiveKit surfaces SIP participant attributes in **dotted** form —
 * `sip.phoneNumber`, `sip.trunkPhoneNumber`, `sip.hostname`, and (for the
 * INVITE headers, when the trunk is created with
 * `includeHeaders=SIP_ALL_HEADERS`, see initialise.ts) `sip.h.<name>` with the
 * header name lowercased — `sip.h.x-<name>` for the X- headers, `sip.h.from`
 * for the From header, and so on. That is the authoritative, lossless form,
 * and it is what the deployed workers actually receive.
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
  /** The inbound INVITE's From header, verbatim (mapped because the trunk
   *  includes ALL headers). Its display-name becomes
   *  metadata.aplisay.callerIdName — see sipFromDisplayName. */
  fromHeader: ["sip.h.from", "sipHFrom"],
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

/**
 * Extract the display-name from a SIP `From` (or any name-addr) header value.
 *
 * RFC 3261: `From = ( name-addr / addr-spec ) *( SEMI from-param )`, with
 * `name-addr = [ display-name ] LAQUOT addr-spec RAQUOT` and
 * `display-name = *(token LWS) / quoted-string`. So a display-name exists only
 * in the angle-bracket form, either as bare tokens (`Alice Smith <sip:…>`) or
 * as a quoted-string (`"Smith, Alice" <sip:…>`) in which a backslash
 * quoted-pair (`\"`, `\\`) escapes the next character. The addr-spec form
 * (`sip:+44…@host;tag=x`) has no display-name at all.
 *
 * Returns the unquoted, unescaped name with control characters removed and
 * whitespace collapsed, or `undefined` when there is none: empty or
 * whitespace-only, `<sip:…>` with nothing in front, an addr-spec form, or a
 * malformed quoted-string (unterminated / not followed by `<addr-spec>`).
 */
export function parseSipDisplayName(
  value: string | undefined | null,
): string | undefined {
  if (!value) return undefined;
  const s = value.trim();
  let name: string;
  if (s.startsWith('"')) {
    let out = "";
    let i = 1;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      if (c === '"') break;
      out += c;
    }
    if (i >= s.length || !s.slice(i + 1).trimStart().startsWith("<")) {
      return undefined;
    }
    name = out;
  } else {
    const lt = s.indexOf("<");
    if (lt <= 0) return undefined;
    name = s.slice(0, lt);
  }
  // Replace C0 controls / DEL with a space, then collapse LWS runs.
  const cleaned = Array.from(name)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

/**
 * The caller's display-name from the inbound INVITE's From header, read from
 * the SIP participant's `sip.h.from` attribute (present when the inbound trunk
 * maps all headers — see initialise.ts). `undefined` when the From carried no
 * display-name or the attribute is absent (outbound / WebRTC, or a trunk still
 * on `SIP_X_HEADERS`). Surfaced as metadata.aplisay.callerIdName.
 */
export function sipFromDisplayName(
  attributes: Record<string, string> | undefined | null,
): string | undefined {
  return parseSipDisplayName(sipAttribute(attributes, "fromHeader"));
}
