/**
 * The ranking and views behind the agent tools, ported from the crawler's
 * directory. The cases and expected values are the crawler's own,
 * apart from syntax.
 *
 * tests/fixtures/directory-golden/golden.json was recorded by running the
 * crawler's code on contacts.json and queries.json. The last block checks the
 * port gives the same answers. The route test checks the same through the
 * database.
 */
import fs from 'node:fs';
import { rankContacts, resolveOutcome, scoreContact } from '../lib/directory/rank.js';
import { lookupView, resolveView, candidateView } from '../lib/directory/views.js';
import { normaliseEntryFields, toE164, classifyPhone } from '../lib/directory/fields.js';

let seq = 0;
function contact(over) {
  seq++;
  return {
    id: `c${seq}`,
    kind: 'person',
    name: 'Nobody',
    role: null,
    department: null,
    about: null,
    extension: null,
    direct: null,
    mobile: null,
    email: null,
    hours: null,
    notesForAgent: null,
    discloseNumbers: false,
    userId: null,
    ...over,
  };
}

const jane = contact({ name: 'Jane Andrews', role: 'Head of Support', department: 'Support', extension: '310', direct: '+442045258830', mobile: '+447700900310', email: 'jane@aplisay.uk', userId: 'u1' });
const johnSales = contact({ name: 'John Smith', role: 'Account Manager', department: 'Sales', extension: '220' });
const johnOps = contact({ name: 'John Smith', role: 'Engineer', department: 'Operations', extension: '231' });
const sue = contact({ name: 'Sue Sinclair', role: 'Sales Executive', department: 'Sales', direct: '+442045258840' });
const accounts = contact({ kind: 'team', name: 'Accounts', department: 'Finance', about: 'Invoices, payments and refunds', direct: '+442045258850', discloseNumbers: true });
const outOfHours = contact({ kind: 'service', name: 'Out of hours line', about: 'Emergencies outside office hours', direct: '+442045258899' });
const all = [jane, johnSales, johnOps, sue, accounts, outOfHours];

describe('number and field parsing, as the crawler does it', () => {
  test('normalises numbers to E.164 with the default country and digits-only extensions', () => {
    const n = normaliseEntryFields({ name: '  Sam  Reed ', extension: 'ext 214', direct: '020 7946 0000', mobile: '07700 900 123' });
    expect(n.ok && n.fields).toEqual({ name: 'Sam Reed', extension: '214', direct: '+442079460000', mobile: '+447700900123' });
  });

  test('rejects a bad phone number, a bad email and a blank name, naming the field', () => {
    expect(normaliseEntryFields({ direct: 'not a number' })).toMatchObject({ ok: false, field: 'direct', code: 'invalid_phone' });
    expect(normaliseEntryFields({ email: 'nope' })).toMatchObject({ ok: false, field: 'email', code: 'invalid_email' });
    expect(normaliseEntryFields({ name: '   ' })).toMatchObject({ ok: false, field: 'name', code: 'name_required' });
  });

  test('blanks clear a field and unknown kinds are refused', () => {
    expect(normaliseEntryFields({ role: '', direct: '' })).toEqual({ ok: true, fields: { role: null, direct: null } });
    expect(normaliseEntryFields({ kind: 'robot' })).toMatchObject({ ok: false, field: 'kind' });
  });

  test('toE164 and classifyPhone', () => {
    expect(toE164('+1 415 555 2671')).toBe('+14155552671');
    expect(toE164('rubbish')).toBeNull();
    expect(classifyPhone('+447700900123')).toBe('mobile');
    expect(classifyPhone('+442079460000')).toBe('direct');
  });

  test('also takes the forms people type', () => {
    expect(toE164('(020) 7946-0000')).toBe('+442079460000');
    expect(toE164('0044 20 7946 0000')).toBe('+442079460000');
    expect(toE164('+44 (0)20 7946 0000')).toBe('+442079460000');
    expect(toE164('')).toBeNull();
    expect(toE164('12')).toBeNull();
  });
});

describe('ranking', () => {
  test('resolves a full name confidently and two same-name people as ambiguous', () => {
    expect(resolveOutcome('Jane Andrews', all)).toMatchObject({ status: 'ok', match: { id: jane.id } });
    const johns = resolveOutcome('John Smith', all);
    expect(johns.status).toBe('ambiguous');
    expect(johns.candidates.map((c) => c.id).sort()).toEqual([johnSales.id, johnOps.id].sort());
  });

  test('survives conversational phrasing and finds a person by role', () => {
    expect(resolveOutcome('put me through to the head of support please', all)).toMatchObject({ status: 'ok', match: { id: jane.id } });
  });

  test('a near miss is offered as a candidate to confirm, never resolved', () => {
    const r = resolveOutcome('Sue Smith', all);
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.map((c) => c.id)).toContain(sue.id);
  });

  test('finds a team by department and a service by what it is about', () => {
    expect(resolveOutcome('accounts', all)).toMatchObject({ status: 'ok', match: { id: accounts.id } });
    expect(rankContacts('refunds', all)[0]?.contact.id).toBe(accounts.id);
    expect(rankContacts('emergency', all)[0]?.contact.id).toBe(outOfHours.id);
  });

  test('returns nothing for an unknown name and respects a kind filter', () => {
    expect(resolveOutcome('Priya Nair', all)).toMatchObject({ status: 'none', candidates: [] });
    expect(rankContacts('John', all, { kind: 'team' })).toEqual([]);
    expect(rankContacts('John', all).map((r) => r.contact.name)).toEqual(['John Smith', 'John Smith']);
  });

  test('ignores accents and case', () => {
    expect(scoreContact('jose nunez', contact({ name: 'José Núñez' }))).toBe(100);
  });
});

describe('agent-facing views', () => {
  test("never shows a person's numbers or email in the lookup view", () => {
    const v = lookupView(jane);
    expect(v).not.toHaveProperty('direct');
    expect(v).not.toHaveProperty('mobile');
    expect(v).not.toHaveProperty('extension');
    expect(JSON.stringify(v)).not.toContain('jane@aplisay.uk');
    expect(v).toMatchObject({ can_transfer: true, can_take_message: true, notes_for_agent: null });
  });

  test("shows a team's numbers only when disclosure is positively on", () => {
    expect(lookupView(accounts)).toMatchObject({ direct: '+442045258850' });
    expect(lookupView(outOfHours)).not.toHaveProperty('direct');
  });

  test('the resolve view carries every target and the linked member address', () => {
    expect(resolveView(jane)).toMatchObject({ extension: '310', direct: '+442045258830', mobile: '+447700900310', message_to: 'jane@aplisay.uk' });
    expect(resolveView(sue).message_to).toBeNull();
  });

  test('the resolve view has no number field beyond the three that saved agents redact', () => {
    const numberLike = Object.entries(resolveView(jane)).filter(([, value]) => typeof value === 'string' && /\+?\d{3,}/.test(value));
    expect(numberLike.map(([key]) => key).sort()).toEqual(['direct', 'extension', 'mobile']);
  });
});

describe("the same answers as the crawler's code", () => {
  const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/directory-golden/golden.json', import.meta.url), 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/directory-golden/contacts.json', import.meta.url), 'utf8'));
  const contacts = golden.order.map((key) => {
    const f = fixture.find((row) => row.key === key);
    return {
      id: f.key, kind: f.kind, name: f.name, role: f.role ?? null, department: f.department ?? null, about: f.about ?? null,
      extension: f.extension ?? null, direct: f.direct ?? null, mobile: f.mobile ?? null, email: f.email ?? null,
      hours: f.hours ?? null, notesForAgent: f.notesForAgent ?? null, discloseNumbers: f.discloseNumbers === true,
      userId: f.login ? `user-${f.key}` : null,
    };
  });

  test.each(golden.lookup.map((row) => [JSON.stringify({ query: row.query, kind: row.kind, limit: row.limit }), row]))('lookup %s', (_, row) => {
    const q = row.query.trim();
    const limit = Math.min(Math.max(Math.trunc(row.limit ?? 8) || 8, 1), 50);
    const matches = q
      ? rankContacts(q, contacts, { kind: row.kind, limit }).map((r) => lookupView(r.contact))
      : contacts.filter((c) => !row.kind || c.kind === row.kind).slice(0, limit).map(lookupView);
    expect({ count: matches.length, matches }).toEqual(row.answer);
  });

  test.each(golden.resolve.filter((row) => row.query !== undefined).map((row) => [JSON.stringify({ query: row.query, kind: row.kind }), row]))('resolve %s', (_, row) => {
    const outcome = resolveOutcome(row.query, contacts, row.kind);
    expect({
      status: outcome.status,
      match: outcome.match ? resolveView(outcome.match) : null,
      candidates: outcome.candidates.map(candidateView),
    }).toEqual(row.answer);
  });
});
