/**
 * The ranking behind the agent tools `directory_lookup` and
 * `directory_resolve`. Pure. Ported from the crawler's directory
 * with the same behaviour and
 * constants, so an agent gets the same answers from either. Change both or
 * neither: tests/directory-rank.test.mjs holds the crawler's own cases.
 *
 * A contact is `{ id, kind, name, role, department, about, ... }`.
 */

/** Grammar and conversational filler that carries no identity ("put me through to..."). */
const STOP = new Set([
  'the', 'of', 'to', 'for', 'and', 'a', 'an', 'in', 'our', 'your', 'please', 'me', 'with', 'speak', 'talk', 'put',
  'through', 'someone', 'i', 'want', 'need', 'can', 'could', 'like', 'would', 'from', 'at', 'on', 'is', 'who',
  'what', 'do', 'does', 'hi', 'hello', 'thanks', 'call', 'calling', 'reach', 'get', 'mr', 'mrs', 'ms', 'dr',
]);
/** Words that describe a kind rather than a target. Ignored unless they are all there is. */
const SOFT = new Set(['team', 'department', 'dept', 'group', 'office', 'staff', 'person', 'people', 'desk']);

/** Minimum score to be offered as a candidate at all. */
export const CANDIDATE_MIN = 40;
/** A confident single match: at least this, and clear of the runner-up by RESOLVE_MARGIN. */
export const RESOLVE_MIN = 80;
export const RESOLVE_MARGIN = 15;

export function normaliseText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Light plural stemming, so "refunds" meets "refund" and "emergencies" meets "emergency". */
function stem(t) {
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

export function tokens(s) {
  return normaliseText(s)
    .split(' ')
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .map(stem);
}

function queryTokens(q) {
  const all = tokens(q);
  const hard = all.filter((t) => !SOFT.has(t));
  return hard.length ? hard : all;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function matchToken(q, t) {
  if (q === t) return 'exact';
  if (q.length >= 3 && t.startsWith(q)) return 'prefix';
  const tolerance = q.length >= 8 ? 2 : q.length >= 5 ? 1 : 0;
  if (tolerance && levenshtein(q, t) <= tolerance) return 'fuzzy';
  return null;
}

function matchCount(qs, ts) {
  let matched = 0;
  let fuzzy = false;
  for (const q of qs) {
    let best = null;
    for (const t of ts) {
      const m = matchToken(q, t);
      if (m === 'exact') {
        best = m;
        break;
      }
      if (m && !best) best = m;
    }
    if (best) {
      matched++;
      if (best === 'fuzzy') fuzzy = true;
    }
  }
  return { matched, fuzzy };
}

/**
 * Score one contact against a query. Identity is the best of name, role and
 * department: a whole name wins outright, and a whole role or department
 * scores nearly as high. `about` only nudges, so a topic never outranks a name.
 */
export function scoreContact(query, c) {
  const q = normaliseText(query);
  const qs = queryTokens(query);
  if (!q || !qs.length) return 0;
  // "Whole" compares the meaningful tokens, so "put me through to the head of
  // support please" still equals the role "Head of Support".
  const qKey = qs.join(' ');
  const whole = (field) => normaliseText(field) === q || tokens(field).join(' ') === qKey;

  let name = 0;
  if (whole(c.name)) name = 100;
  else {
    const { matched, fuzzy } = matchCount(qs, tokens(c.name));
    if (matched === qs.length && qs.length >= 2) name = fuzzy ? 80 : 85;
    else if (matched >= 1 && qs.length === 1) name = fuzzy ? 55 : 70;
    else if (matched >= 1) name = 35 + Math.round(15 * (matched / qs.length));
  }

  let role = 0;
  if (c.role) {
    if (whole(c.role)) role = 95;
    else {
      const { matched } = matchCount(qs, tokens(c.role));
      if (matched === qs.length) role = 75;
      else if (matched) role = Math.min(40, 20 * matched);
    }
  }

  let dept = 0;
  if (c.department) {
    const team = c.kind !== 'person';
    if (whole(c.department)) dept = team ? 90 : 60;
    else {
      const { matched } = matchCount(qs, tokens(c.department));
      if (matched === qs.length) dept = team ? 75 : 50;
      else if (matched) dept = Math.min(30, 15 * matched);
    }
  }

  // A topic match surfaces as a candidate but never resolves on its own: it is
  // below RESOLVE_MIN, so the agent asks before it transfers.
  let about = 0;
  if (c.about) {
    const { matched } = matchCount(qs, tokens(c.about));
    if (matched === qs.length) about = 50;
    else if (matched) about = Math.min(36, 12 * matched);
  }

  const identity = Math.max(name, role, dept, about);
  const nudge = identity >= 100 || identity === about ? 0 : Math.min(10, about / 5);
  return Math.min(100, Math.round(identity + nudge));
}

/** Contacts that score at least CANDIDATE_MIN, best first. Ties keep the name order, then the input order. */
export function rankContacts(query, contacts, opts = {}) {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 8) || 8, 1), 50);
  return contacts
    .filter((c) => !opts.kind || c.kind === opts.kind)
    .map((contact) => ({ contact, score: scoreContact(query, contact) }))
    .filter((r) => r.score >= CANDIDATE_MIN)
    .sort((a, b) => b.score - a.score || a.contact.name.localeCompare(b.contact.name))
    .slice(0, limit);
}

/**
 * `ok` only for a confident match with no close rival. `ambiguous` when the
 * caller must be asked. `none` when nothing comes close. Never guesses.
 */
export function resolveOutcome(query, contacts, kind) {
  const ranked = rankContacts(query, contacts, { kind, limit: 5 });
  if (!ranked.length) return { status: 'none', match: null, candidates: [] };
  const [top, next] = ranked;
  const confident = top.score >= RESOLVE_MIN && (!next || next.score <= top.score - RESOLVE_MARGIN);
  if (confident) return { status: 'ok', match: top.contact, candidates: [] };
  return { status: 'ambiguous', match: null, candidates: ranked.map((r) => r.contact) };
}
