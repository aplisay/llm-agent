/**
 * The directory as agents search it: `GET /directory/lookup` and
 * `GET /directory/resolve`. The answers have the shape the crawler's
 * `/v1/directory/*` routes give today, so the crawler can pass them through.
 */
import { DirectoryEntry } from '../database.js';
import { hasCapability } from '../capabilities.js';
import { loadIndex } from '../pbx/directory-views.js';
import { shownNumber } from '../pbx/snapshot.js';
import { rankContacts, resolveOutcome } from './rank.js';
import { lookupView, resolveView, candidateView } from './views.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['person', 'team', 'service'];

export const kindOf = (value) => (KINDS.includes(String(value)) ? String(value) : undefined);

/** One entry as the ranking and the views read it. */
function toContact(entry, index) {
  const extension = index.extensionByEntry.get(entry.id) || null;
  let { direct } = entry;
  // An extension of our own rings only on a phone system call. Elsewhere the
  // agent falls through to `direct`, so that is the number that rings it.
  if (!direct && extension && extension.type !== 'connection' && hasCapability(index.organisation, 'phoneSystem')) {
    direct = shownNumber(index, extension).number;
  }
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    role: entry.role,
    department: entry.department,
    about: entry.about,
    hours: entry.hours,
    notesForAgent: entry.notesForAgent,
    discloseNumbers: entry.discloseNumbers,
    extension: extension?.number ?? null,
    direct: direct ?? null,
    mobile: entry.mobile,
    email: entry.email,
    userId: entry.loginUserId,
  };
}

/** Every live contact of the organisation, in the crawler's order: by name without case, then oldest first. */
export async function loadContacts(organisationId, where = {}) {
  const index = await loadIndex(organisationId);
  if (!index) return null;
  const { sequelize } = DirectoryEntry;
  const rows = await DirectoryEntry.findAll({
    where: { organisationId, deletedAt: null, ...where },
    order: [[sequelize.fn('lower', sequelize.col('name')), 'ASC'], ['createdAt', 'ASC']],
  });
  return rows.map((row) => toContact(row, index));
}

/** `{ count, matches }`. No query lists the directory, so an agent can answer "who do you have?". */
export async function lookupDirectory(organisationId, { query, kind, limit } = {}) {
  const contacts = await loadContacts(organisationId);
  if (!contacts) return null;
  const q = String(query ?? '').trim();
  const size = Math.min(Math.max(Math.trunc(Number(limit) || 8) || 8, 1), 50);
  const matches = q
    ? rankContacts(q, contacts, { kind, limit: size }).map((r) => lookupView(r.contact))
    : contacts.filter((c) => !kind || c.kind === kind).slice(0, size).map(lookupView);
  return { count: matches.length, matches };
}

/** `{ status, match, candidates }`, by id or by a spoken name. */
export async function resolveDirectory(organisationId, { contactId, query, kind } = {}) {
  let outcome;
  if (contactId) {
    const contacts = UUID_RE.test(contactId) ? await loadContacts(organisationId, { id: contactId }) : [];
    if (contacts === null) return null;
    outcome = contacts.length ? { status: 'ok', match: contacts[0], candidates: [] } : { status: 'none', match: null, candidates: [] };
  } else {
    const contacts = await loadContacts(organisationId);
    if (!contacts) return null;
    outcome = resolveOutcome(query ?? '', contacts, kind);
  }
  return {
    status: outcome.status,
    match: outcome.match ? resolveView(outcome.match) : null,
    candidates: outcome.candidates.map(candidateView),
  };
}
