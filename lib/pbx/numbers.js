/**
 * Small number helpers for the phone system. Pure.
 */

/** `+E.164` from a stored number with or without its plus, or null. */
export function plusE164(number) {
  const digits = String(number ?? '').replace(/[^0-9]/g, '');
  return digits ? `+${digits}` : null;
}

const UK_GROUPS = [
  [/^(2\d)(\d{4})(\d{4})$/, '$1 $2 $3'],          // 020 7946 0810
  [/^(7\d{3})(\d{6})$/, '$1 $2'],                  // 07700 900123
  [/^(1\d1|11\d)(\d{3})(\d{4})$/, '$1 $2 $3'],     // 0113 496 0000, 0161 496 0000
  [/^(1\d{3})(\d{5,6})$/, '$1 $2'],                // 01632 960000
  [/^([389]\d{2})(\d{3})(\d{4})$/, '$1 $2 $3'],    // 0300 123 4567, 0800 123 4567
];

/**
 * A number written for people: "+44 20 7946 0810". UK numbers are grouped.
 * Any other number is returned in E.164 form, unchanged.
 */
export function displayNumber(number) {
  const e164 = plusE164(number);
  if (!e164) return String(number ?? '');
  if (!e164.startsWith('+44')) return e164;
  const national = e164.slice(3);
  for (const [pattern, groups] of UK_GROUPS) {
    if (pattern.test(national)) return `+44 ${national.replace(pattern, groups)}`;
  }
  return e164;
}

/**
 * Dialled digits as `+E.164`, or null. A national number with a leading 0 is
 * read in the default country.
 */
export function canonicalDialled(digits, { countryCode = '44' } = {}) {
  const raw = String(digits ?? '').trim();
  if (!/^\+?[0-9]+$/.test(raw)) return null;
  let e164;
  if (raw.startsWith('+')) e164 = raw;
  else if (raw.startsWith('00')) e164 = `+${raw.slice(2)}`;
  else if (raw.startsWith('0')) e164 = `+${countryCode}${raw.slice(1)}`;
  else return null;
  return /^\+[1-9][0-9]{6,14}$/.test(e164) ? e164 : null;
}

export const EMERGENCY_NUMBERS = ['999', '112'];
