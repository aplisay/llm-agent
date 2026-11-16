/**
 * Checks and tidies the fields of a directory entry. Pure.
 *
 * Returns `{ ok: true, fields }` with only the fields that were given, or
 * `{ ok: false, code, field, error }` for the first one at fault.
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { DIRECTORY_ENTRY_KINDS } from '../database-models/directory-entry.js';

const TEXT_CAPS = { name: 120, role: 120, department: 80, about: 600, hours: 200, notesForAgent: 1000, email: 254 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9][0-9]{6,14}$/;

const text = (value) => {
  if (value == null) return null;
  const tidy = String(value).replace(/\s+/g, ' ').trim();
  return tidy || null;
};

/**
 * `+E.164`, or null. The same parsing as the crawler's directory, so a number
 * means the same in both: national forms for `defaultCountry`, strict on shape,
 * lenient on range. A number the metadata calls only "possible" is kept: a new
 * range, or the 07700 900xxx numbers Ofcom keeps for examples.
 */
export function toE164(raw, defaultCountry = 'GB') {
  const cleaned = String(raw ?? '').replace(/[^\d+()\-.\s]/g, '').trim();
  if (!cleaned) return null;
  try {
    const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
    if (parsed && (parsed.isValid() || parsed.isPossible())) return parsed.number;
  } catch {
    // Fall through to the plain shape check.
  }
  return E164_RE.test(cleaned) ? cleaned : null;
}

/** Which field a number belongs in. When the metadata cannot type it, 07 is a UK mobile. */
export function classifyPhone(e164) {
  try {
    const type = parsePhoneNumberFromString(e164)?.getType();
    if (type === 'MOBILE') return 'mobile';
    if (type === undefined && /^\+447/.test(e164)) return 'mobile';
  } catch {
    // A number that cannot be typed is a direct line.
  }
  return 'direct';
}

export function normaliseEntryFields(input = {}) {
  const fields = {};
  const fail = (field, code, error) => ({ ok: false, code, field, error });

  if ('kind' in input) {
    const kind = text(input.kind)?.toLowerCase();
    if (kind && !DIRECTORY_ENTRY_KINDS.includes(kind)) return fail('kind', 'invalid_kind', 'Kind must be person, team or service.');
    if (kind) fields.kind = kind;
  }
  if ('name' in input) {
    const name = text(input.name);
    if (!name) return fail('name', 'name_required', 'A name is needed.');
    fields.name = name.slice(0, TEXT_CAPS.name);
  }
  for (const field of ['role', 'department', 'about', 'hours', 'notesForAgent']) {
    if (field in input) {
      const value = text(input[field]);
      fields[field] = value ? value.slice(0, TEXT_CAPS[field]) : null;
    }
  }
  if ('extension' in input) {
    const raw = text(input.extension);
    const digits = raw ? raw.replace(/\D/g, '') : '';
    if (raw && !digits) return fail('extension', 'invalid_extension', 'An extension is digits only.');
    if (digits.length > 8) return fail('extension', 'invalid_extension', 'An extension is at most 8 digits.');
    fields.extension = digits || null;
  }
  for (const field of ['direct', 'mobile']) {
    if (field in input) {
      const raw = text(input[field]);
      if (!raw) {
        fields[field] = null;
        continue;
      }
      const e164 = toE164(raw);
      if (!e164) {
        return fail(field, 'invalid_phone', `Enter a full phone number for ${field === 'direct' ? 'the direct line' : 'the mobile'}.`);
      }
      fields[field] = e164;
    }
  }
  if ('email' in input) {
    const email = text(input.email)?.toLowerCase() ?? null;
    if (email && !EMAIL_RE.test(email)) return fail('email', 'invalid_email', 'Enter a valid email address.');
    fields.email = email ? email.slice(0, TEXT_CAPS.email) : null;
  }
  if ('discloseNumbers' in input) {
    fields.discloseNumbers = input.discloseNumbers === true || input.discloseNumbers === 'true';
  }
  if ('loginUserId' in input) {
    fields.loginUserId = text(input.loginUserId);
  }
  if ('notes' in input) {
    if (input.notes !== null && (typeof input.notes !== 'object' || Array.isArray(input.notes))) {
      return fail('notes', 'invalid_notes', 'notes must be an object.');
    }
    fields.notes = input.notes;
  }
  return { ok: true, fields };
}
