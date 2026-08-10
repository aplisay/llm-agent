/**
 * Outbound call filter primitives — pure pattern handling with NO imports at all,
 * so the model layer (`Trunk.outboundCallFilter` validation in lib/database.js)
 * can use them without an import cycle. The policy that decides WHICH filters
 * apply to a given leg lives in lib/outbound-authorisation.js.
 *
 * @module lib/outbound-filter
 */

/**
 * Historical platform default when an agent sets no `outboundCallFilter`: UK
 * geographic (01/02), non-geographic (03) and mobile (07), in any of the dialled
 * forms the platform has always accepted (`+44…`, `44…`, `0…`). Applied to the
 * RAW dialled string, exactly as the previous inline checks in the originate
 * endpoint and the LiveKit transfer handler did.
 */
export const DEFAULT_AGENT_OUTBOUND_FILTER = '^(\\+44|44|0)[1237]\\d{6,15}$';

/**
 * Default `Trunk.outboundCallFilter` for a chargeable trunk that has none
 * configured: UK geographic/non-geographic/mobile in CANONICAL `+E.164` form
 * (the form this filter is always applied to, so there is exactly one way to
 * write an operator pattern). `[1237]` + 8–9 further digits covers both the
 * 9- and 10-digit national formats.
 */
export const DEFAULT_TRUNK_OUTBOUND_FILTER = '^\\+44[1237]\\d{8,9}$';

/**
 * Upper bound on an accepted filter pattern. Both agent- and operator-supplied
 * patterns are compiled into a RegExp, so cap the source length to keep the
 * catastrophic-backtracking surface small (destinations are themselves capped at
 * E.164's 15 digits, which bounds the input side).
 */
export const MAX_FILTER_LENGTH = 512;

/** Longest string we will ever run a filter against (E.164 + punctuation slack). */
export const MAX_DESTINATION_LENGTH = 32;

/**
 * Validate a user/operator-supplied outbound call filter pattern.
 * @param {*} pattern
 * @returns {string|null} an error message, or null when the pattern is usable
 */
export function validateOutboundCallFilter(pattern) {
  if (pattern == null || pattern === '') return null;
  if (typeof pattern !== 'string') return 'outboundCallFilter must be a string';
  if (pattern.length > MAX_FILTER_LENGTH) {
    return `outboundCallFilter must be at most ${MAX_FILTER_LENGTH} characters`;
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (e) {
    return `outboundCallFilter is not a valid regular expression: ${e.message}`;
  }
  return null;
}

/**
 * Test `value` against a filter `pattern`. Never throws: an unusable pattern
 * (invalid regex, over-long, non-string) is treated as NOT matching, so a
 * malformed filter fails closed rather than opening the gate.
 *
 * @returns {boolean}
 */
export function filterAllows(pattern, value) {
  if (typeof value !== 'string' || !value || value.length > MAX_DESTINATION_LENGTH) return false;
  if (validateOutboundCallFilter(pattern) !== null) return false;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}
