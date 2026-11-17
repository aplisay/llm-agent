/**
 * Caller-identity headers on the SIP legs this worker dials (originate,
 * blind bridged transfer, consult dial), switched on per egress trunk by
 * `trunks.flags`. See docs/phone-endpoints-api.md#trunk-flags.
 */

export interface SipIdentityFlags {
  /** Add P-Asserted-Identity carrying the agent's own number. */
  sendPai?: boolean;
  /** Add Remote-Party-ID carrying the agent's own number. */
  sendRpid?: boolean;
  /** On a transfer leg, present the original caller in From. */
  fromOriginalCaller?: boolean;
  /** PAI / RPID as a tel: URI instead of sip: on the next hop. */
  useTelUriId?: boolean;
}

export interface SipIdentity {
  flags?: SipIdentityFlags | null;
  /** The agent's own number on this call. */
  assertedNumber?: string | null;
  /** The other party on the session's first leg. Set only for transfer legs. */
  originalCaller?: string | null;
}

/** The parts of a transfer's context that decide its identity. */
export interface TransferIdentitySource {
  /** True for an originated call: callerId is then the agent's number and calledId the far party. */
  outbound?: boolean;
  callerId: string;
  calledId: string;
  /** Identity flags of the trunk the session's own number is on. */
  sipIdentityFlags?: SipIdentityFlags | null;
}

export interface SipIdentityResult {
  fromNumber: string;
  headers: Record<string, string>;
  /** True when the flags asked for PAI or RPID but the agent's number was not usable. */
  assertedNumberRejected: boolean;
}

/** The identity flags from a trunk's `flags`, each only when exactly `true`. */
export function pickSipIdentityFlags(flags: unknown): SipIdentityFlags | null {
  if (!flags || typeof flags !== "object") return null;
  const f = flags as Record<string, unknown>;
  const picked: SipIdentityFlags = {};
  if (f.sendPai === true) picked.sendPai = true;
  if (f.sendRpid === true) picked.sendRpid = true;
  if (f.fromOriginalCaller === true) picked.fromOriginalCaller = true;
  if (f.useTelUriId === true) picked.useTelUriId = true;
  return Object.keys(picked).length ? picked : null;
}

/**
 * A number as `+` and digits, or null when it is not a plausible E.164
 * number. Accepts a bare number or a sip:/tel: URI. UK national `0…` reads
 * as `+44…` (as elsewhere in this worker) and `00…` as `+…`.
 */
export function toE164(number: string | null | undefined): string | null {
  if (typeof number !== "string") return null;
  let s = number.trim().replace(/^<|>$/g, "").replace(/^(sip|sips|tel):/i, "");
  s = s.split(/[@;]/)[0].replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(s)) return null;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  else if (s.startsWith("0")) s = `+44${s.slice(1)}`;
  else if (!s.startsWith("+")) s = `+${s}`;
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

/** The host part of a SIP address such as `sip:sbc.example.com:5061;transport=tls`. */
export function sipHost(address: string | null | undefined): string | null {
  if (typeof address !== "string") return null;
  let h = address.trim().replace(/^(sip|sips):/i, "");
  h = h.split(";")[0];
  h = h.includes("@") ? h.slice(h.lastIndexOf("@") + 1) : h;
  if (h.startsWith("[")) h = h.slice(0, h.indexOf("]") + 1);
  else h = h.split(":")[0];
  return h || null;
}

/**
 * The From number and extra INVITE headers for one dialled leg.
 *
 * @param host - The next hop this leg is sent to (our SBC or a registration's
 *   B2BUA); it becomes the host of the PAI / RPID URI. Without one, or with
 *   `useTelUriId`, the URI is `tel:`.
 */
export function applySipIdentity(
  identity: SipIdentity | null | undefined,
  fromNumber: string,
  host?: string | null,
): SipIdentityResult {
  const headers: Record<string, string> = {};
  const flags = identity?.flags;
  if (!flags) {
    return { fromNumber, headers, assertedNumberRejected: false };
  }
  let from = fromNumber;
  if (flags.fromOriginalCaller) {
    const caller = toE164(identity?.originalCaller);
    if (caller) from = caller;
  }
  let assertedNumberRejected = false;
  if (flags.sendPai || flags.sendRpid) {
    const asserted = toE164(identity?.assertedNumber);
    if (!asserted) {
      assertedNumberRejected = true;
    } else {
      const h = flags.useTelUriId ? null : sipHost(host);
      const identityValue = h
        ? `"${asserted}" <sip:${asserted}@${h}>`
        : `<tel:${asserted}>`;
      if (flags.sendPai) {
        headers["P-Asserted-Identity"] = identityValue;
      }
      if (flags.sendRpid) {
        headers["Remote-Party-ID"] = `${identityValue};party=calling;screen=yes;privacy=off`;
      }
    }
  }
  return { fromNumber: from, headers, assertedNumberRejected };
}

/**
 * Identity for the legs a transfer dials. The asserted number is the
 * session's own DDI, not a caller id the model passed; a WebRTC session has
 * no DDI, so it falls back to the validated caller id.
 *
 * @param egressIdentityFlags - Set when the transfer's caller id moved the
 *   leg onto another egress (null: that egress has no trunk flags).
 */
export function transferSipIdentity(
  context: TransferIdentitySource,
  effectiveCallerId: string,
  egressIdentityFlags?: SipIdentityFlags | null,
): SipIdentity | null {
  const flags =
    egressIdentityFlags !== undefined ? egressIdentityFlags : context.sipIdentityFlags;
  if (!flags) return null;
  const ownNumber = context.outbound ? context.callerId : context.calledId;
  const otherParty = context.outbound ? context.calledId : context.callerId;
  return {
    flags,
    assertedNumber: toE164(ownNumber) ? ownNumber : effectiveCallerId,
    originalCaller: otherParty,
  };
}
