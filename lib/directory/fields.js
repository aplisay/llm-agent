/**
 * Checks and tidies the fields of a directory entry. Pure.
 *
 * Returns `{ ok: true, fields }` with only the fields that were given, or
 * `{ ok: false, code, field, error }` for the first one at fault.
 */
import { DIRECTORY_ENTRY_KINDS } from '../database-models/directory-entry.js';

const TEXT_CAPS = { name: 120, role: 120, department: 80, about: 600, hours: 200, notesForAgent: 1000, email: 254 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9][0-9]{6,14}$/;

const text = (value) => {
  if (value == null) return null;
  const tidy = String(value).replace(/\s+/g, ' ').trim();
  return tidy || null;
};

/** `+E.164`, or null. Accepts a national number with a leading 0 for the default country. */
export function toE164(raw, countryCode = '44') {
  const cleaned = String(raw ?? '').replace(/[\s().-]/g, '');
  if (!/^\+?[0-9]+$/.test(cleaned)) return null;
  let e164 = cleaned;
  if (cleaned.startsWith('00')) e164 = `+${cleaned.slice(2)}`;
  else if (cleaned.startsWith('0')) e164 = `+${countryCode}${cleaned.slice(1)}`;
  else if (!cleaned.startsWith('+')) e164 = `+${cleaned}`;
  return E164_RE.test(e164) ? e164 : null;
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
