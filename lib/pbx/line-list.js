/**
 * Every desk phone line, with the `from` and `caller` blocks that a plan for a
 * call from it carries. Call control reads the list at start and every few
 * minutes, so that an emergency call it must place with no plan still shows a
 * number (docs/phone-system.md, "The list of lines").
 *
 * The blocks are worked out from an organisation's whole directory, about
 * fifteen queries. So each organisation's lines are kept in memory against a
 * marker made from its tables, and its directory is read again only when the
 * marker moves.
 */
import { createHash } from 'node:crypto';
import { Organisation as DefaultOrganisation } from '../database.js';
import { indexSnapshot } from './snapshot.js';
import { loadSnapshot as defaultLoadSnapshot } from './store.js';
import { lineBlocks } from './ring-plan.js';
import { assertPhoneSystemSchema, PbxError } from './errors.js';

export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 100;
// A kept organisation is read again after this long whatever its marker says,
// so a change that the marker does not see cannot last.
export const KEPT_MS = 6 * 60 * 60 * 1000;
const MAX_KEPT = 5000;

/** organisationId to `{ marker, lines, at }`. In this process only. */
const kept = new Map();

/** Forget every kept organisation. For tests. */
export function forgetLines() {
  kept.clear();
}

const cursorOf = (organisationId) => `o1-${Buffer.from(organisationId, 'utf8').toString('base64url')}`;

function afterOf(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return '';
  const text = /^o1-([A-Za-z0-9_-]+)$/.exec(String(cursor))?.[1];
  const organisationId = text ? Buffer.from(text, 'base64url').toString('utf8') : '';
  if (!organisationId || cursorOf(organisationId) !== cursor) {
    throw new PbxError(400, 'bad_request', 'after must be the next of the page before', { field: 'after' });
  }
  return organisationId;
}

/**
 * The organisations of a page: those with a line that has a SIP account.
 * Whatever their switches: a line of an organisation with the phone system
 * off, or deactivated, still gets an emergency plan.
 */
async function organisationsAfter(after, limit, Organisation) {
  const { sequelize } = Organisation;
  const rows = await sequelize.query(
    `SELECT o.id FROM organisations o
      WHERE o.id COLLATE "C" > :after
        AND EXISTS (SELECT 1 FROM lines l WHERE l.organisation_id = o.id AND l.endpoint_id IS NOT NULL)
      ORDER BY o.id COLLATE "C" LIMIT :limit`,
    { replacements: { after, limit }, type: sequelize.QueryTypes.SELECT },
  );
  return rows.map((row) => row.id);
}

// Every column of every row: these tables hold nothing that changes by itself.
const WHOLE_ROWS = ['lines', 'phones', 'phone_people', 'extensions', 'extension_members', 'directory_entries'];
// Named columns only: the rest of these rows changes with every registration, fetch, call or charge.
const NAMED_COLUMNS = [
  `SELECT l.organisation_id AS id, 'accounts' AS part, md5(string_agg(t.id::text || ':' || t.username, ',' ORDER BY t.id)) AS digest
     FROM lines l JOIN phone_registrations t ON t.id = l.endpoint_id WHERE l.organisation_id IN (:ids) GROUP BY 1`,
  `SELECT t.organisation_id, 'numbers', md5(string_agg(t.id::text || ':' || t.number || ':' || coalesce(t.extension_id::text, ''), ',' ORDER BY t.id))
     FROM phone_numbers t WHERE t.organisation_id IN (:ids) GROUP BY 1`,
  `SELECT t.organisation_id, 'devices', md5(string_agg(t.id::text || ':' || coalesce(t.vendor, '') || ':' || coalesce(t.model, '') || ':' || coalesce(t.reported_model, ''), ',' ORDER BY t.id))
     FROM devices t WHERE t.organisation_id IN (:ids) GROUP BY 1`,
  `SELECT t.id, 'organisation', md5(coalesce(t.main_number, '')) FROM organisations t WHERE t.id IN (:ids)`,
];

/**
 * A marker for each organisation that moves whenever something its lines'
 * blocks are worked out from changes: a digest of the rows that
 * `loadSnapshot` reads for `lineBlocks`. One query for the page.
 */
async function markersOf(ids, { sequelize }) {
  if (!ids.length) return new Map();
  const whole = WHOLE_ROWS.map((table) => `SELECT t.organisation_id AS id, '${table}' AS part, md5(string_agg(md5(t::text), ',' ORDER BY t.id)) AS digest
     FROM ${table} t WHERE t.organisation_id IN (:ids) GROUP BY 1`);
  const rows = await sequelize.query([...whole, ...NAMED_COLUMNS].join('\nUNION ALL\n'), {
    replacements: { ids }, type: sequelize.QueryTypes.SELECT,
  });
  const parts = new Map(ids.map((id) => [id, []]));
  for (const row of rows) parts.get(row.id)?.push(`${row.part}=${row.digest}`);
  return new Map([...parts].map(([id, list]) => [
    id, createHash('sha256').update(`1\n${list.sort().join('\n')}`).digest('hex').slice(0, 32),
  ]));
}

async function linesOf(organisationId, loadSnapshot) {
  const snapshot = await loadSnapshot(organisationId);
  if (!snapshot) return [];
  const index = indexSnapshot(snapshot);
  return snapshot.lines
    .filter((line) => line.endpoint?.username)
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((line) => ({ username: line.endpoint.username, organisationId, ...lineBlocks(index, line) }));
}

/**
 * A page of lines: every line of each of `limit` organisations, in
 * organisation order and then line order.
 *
 * @param {object} query
 * @param {string} [query.after] the `next` of the page before. Absent or empty for the first page
 * @param {number} [query.limit] how many organisations, not how many lines
 * @returns {Promise<{ lines: object[], next: string|null }>}
 */
export async function listLines({ after, limit = DEFAULT_PAGE } = {}, deps = {}) {
  const { Organisation = DefaultOrganisation, loadSnapshot = defaultLoadSnapshot, now = Date.now } = deps;
  assertPhoneSystemSchema();
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new PbxError(400, 'bad_request', `limit must be a whole number from 1 to ${MAX_PAGE}`, { field: 'limit' });
  }
  const found = await organisationsAfter(afterOf(after), limit + 1, Organisation);
  const ids = found.slice(0, limit);
  // Read before the directory, so lines are never kept against a marker newer than they are.
  const markers = await markersOf(ids, Organisation);
  const lines = [];
  for (const id of ids) {
    const marker = markers.get(id);
    let entry = kept.get(id);
    if (!entry || entry.marker !== marker || now() - entry.at >= KEPT_MS) {
      entry = { marker, lines: await linesOf(id, loadSnapshot), at: now() };
      kept.delete(id);
      kept.set(id, entry);
      if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
    }
    lines.push(...entry.lines);
  }
  return { lines, next: found.length > limit ? cursorOf(ids[ids.length - 1]) : null };
}
