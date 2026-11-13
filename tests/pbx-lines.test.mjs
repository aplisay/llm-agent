/**
 * The working-out of a phone's lines, checked against fixed cases. Pure code,
 * no database. Capacities are set on each phone, not read from the catalogue.
 */
import {
  workOutLines, maxPeople, lineIdentity, diffLines, lineLabel, RINGING_TYPES,
} from '../lib/pbx/lines.js';
import {
  indexSnapshot, linesInput, labelFor, ownedExtension, shownNumber, lineForExtension, callingExtension,
} from '../lib/pbx/snapshot.js';
import {
  phoneModel, normaliseMac, isSnomMac, phoneCapacity,
} from '../lib/pbx/phone-models.js';

// Sample people, teams and extensions.
const PEOPLE = {
  rob: 'Rob Parkinson',
  priya: 'Priya Nair',
  jane: 'Jane Andrews',
  sam: 'Sam Reed',
  mo: 'Mo Hassan',
  ellie: 'Ellie Brook',
  tom: 'Tom Okafor',
};
const TEAMS = {
  sales: 'Sales',
  support: 'Support',
  warehouse: 'Warehouse',
  returns: 'Returns',
  deliveries: 'Deliveries',
};
const OWNED = { rob: '100', priya: '101', jane: '102', sam: '103', mo: '104', ellie: '105' };
const SHARED = { sales: '200', support: '210', warehouse: '230', returns: '240', deliveries: '250' };
// Each person's shared extensions, in key order.
const KEY_ORDER = {
  rob: ['sales', 'support'],
  priya: ['sales'],
  jane: ['support'],
  sam: ['sales', 'support', 'warehouse'],
  mo: ['support', 'warehouse', 'returns', 'deliveries'],
  ellie: ['sales', 'support'],
  tom: [],
};

const extId = (number) => `ext-${number}`;

function baseSnapshot() {
  const entries = [
    ...Object.entries(PEOPLE).map(([id, name]) => ({ id, kind: 'person', name })),
    ...Object.entries(TEAMS).map(([id, name]) => ({ id, kind: 'team', name })),
  ];
  const extensions = [
    ...Object.entries(OWNED).map(([entryId, number]) => ({ id: extId(number), number, type: 'ring_all', entryId })),
    ...Object.entries(SHARED).map(([entryId, number]) => ({ id: extId(number), number, type: 'ring_all', entryId })),
  ];
  const members = [];
  // Owners are members of their own extension too. These rows must not count as shared keys.
  for (const [entryId, number] of Object.entries(OWNED)) {
    members.push({ extensionId: extId(number), entryId, huntPosition: 1, keyPosition: null });
  }
  for (const [person, teams] of Object.entries(KEY_ORDER)) {
    teams.forEach((team, i) => {
      members.push({ extensionId: extId(SHARED[team]), entryId: person, huntPosition: 1, keyPosition: i + 1 });
    });
  }
  return { organisation: { id: 'org' }, entries, extensions, members, phones: [], phonePeople: [] };
}

function addPhone(snapshot, { id, kind = 'deskphone', capacity, labelChars = 12, people = [] }) {
  snapshot.phones.push({ id, kind, capacity, labelChars });
  people.forEach((entryId, i) => snapshot.phonePeople.push({ phoneId: id, entryId, position: i + 1 }));
}

function setKeyPosition(snapshot, entryId, team, keyPosition) {
  const row = snapshot.members.find((m) => m.entryId === entryId && m.extensionId === extId(SHARED[team]));
  if (row) row.keyPosition = keyPosition;
  else snapshot.members.push({ extensionId: extId(SHARED[team]), entryId, huntPosition: 9, keyPosition });
}

function removeMember(snapshot, entryId, extensionId) {
  snapshot.members = snapshot.members.filter((m) => !(m.entryId === entryId && m.extensionId === extensionId));
}

function setType(snapshot, extensionId, type) {
  snapshot.extensions.find((e) => e.id === extensionId).type = type;
}

function slotsFor(snapshot, phoneId) {
  const index = indexSnapshot(snapshot);
  return workOutLines(linesInput(index, index.phones.get(phoneId)));
}

// Expected slot shorthand. Arguments are extension numbers.
const ext = (position, number) => ({ position, kind: 'extension', extensionId: extId(number) });
const other = (position, numbers) => ({ position, kind: 'other', covers: numbers.map(extId) });

// The lines a phone would hold after applying these slots.
const asLines = (slots, phoneId = 'p') => slots.map((slot) => ({
  id: `${phoneId}-line-${lineIdentity(slot)}`,
  position: slot.position,
  kind: slot.kind,
  extensionId: slot.extensionId,
  covers: slot.covers,
}));

const name = (lineOrSlot) => (lineOrSlot.kind === 'other' ? 'other' : lineOrSlot.extensionId);

// On a desk phone each line has its own SIP account.
function change(beforeSlots, afterSlots) {
  const diff = diffLines(asLines(beforeSlots), afterSlots);
  return {
    added: diff.added.map(name).sort(),
    removed: diff.removed.map(name).sort(),
    moved: diff.moved.map(({ slot }) => name(slot)).sort(),
    accountsCreated: diff.added.length,
    accountsRemoved: diff.removed.length,
    coverChanged: diff.coverChanged,
    changed: diff.changed,
    diff,
  };
}

describe('worked cases', () => {
  test('a person\'s desk, home and mobile phones are added', () => {
    const s = baseSnapshot();
    addPhone(s, { id: 'rob-desk', capacity: 12, people: ['rob'] });
    addPhone(s, { id: 'rob-home', capacity: 8, people: ['rob'] });
    addPhone(s, { id: 'rob-mobile', kind: 'external', capacity: 0, people: ['rob'] });

    const desk = slotsFor(s, 'rob-desk');
    const home = slotsFor(s, 'rob-home');
    expect(desk).toEqual([ext(1, '100'), ext(2, '200'), ext(3, '210')]);
    expect(home).toEqual([ext(1, '100'), ext(2, '200'), ext(3, '210')]);
    expect(slotsFor(s, 'rob-mobile')).toEqual([]);

    const changes = [change([], desk), change([], home)];
    expect(changes.reduce((n, c) => n + c.accountsCreated, 0)).toBe(6);
    expect(changes.reduce((n, c) => n + c.accountsRemoved, 0)).toBe(0);
    expect(changes.every((c) => c.moved.length === 0)).toBe(true);

    // A change of type within the ringing types changes nothing.
    setType(s, extId('200'), 'hunt');
    expect(change(desk, slotsFor(s, 'rob-desk')).changed).toBe(false);
    expect(change(home, slotsFor(s, 'rob-home')).changed).toBe(false);
  });

  test('a phone shared by two people places each extension once', () => {
    const s = baseSnapshot();
    addPhone(s, { id: 'warehouse', capacity: 12, people: ['sam', 'mo'] });
    const slots = slotsFor(s, 'warehouse');
    expect(slots).toEqual([
      ext(1, '103'), ext(2, '104'), ext(3, '200'), ext(4, '210'),
      ext(5, '230'), ext(6, '240'), ext(7, '250'),
    ]);
    expect(change([], slots).accountsCreated).toBe(7);
  });

  test('an assistant is added as a member of a personal extension', () => {
    const s = baseSnapshot();
    addPhone(s, { id: 'priya-desk', capacity: 8, people: ['priya'] });
    addPhone(s, { id: 'rob-desk', capacity: 12, people: ['rob'] });
    addPhone(s, { id: 'rob-home', capacity: 8, people: ['rob'] });
    const before = {
      priya: slotsFor(s, 'priya-desk'), desk: slotsFor(s, 'rob-desk'), home: slotsFor(s, 'rob-home'),
    };
    expect(before.priya).toEqual([ext(1, '101'), ext(2, '200')]);

    s.members.push({ extensionId: extId('100'), entryId: 'priya', huntPosition: 2, keyPosition: 1 });
    setKeyPosition(s, 'priya', 'sales', 2);

    const priyaAfter = slotsFor(s, 'priya-desk');
    expect(priyaAfter).toEqual([ext(1, '101'), ext(2, '100'), ext(3, '200')]);

    const c = change(before.priya, priyaAfter);
    expect(c.added).toEqual([extId('100')]);
    expect(c.removed).toEqual([]);
    expect(c.moved).toEqual([extId('200')]);
    expect(c.accountsCreated).toBe(1);
    expect(c.accountsRemoved).toBe(0);
    // Sales keeps its line (same id) at the new key.
    const sales = c.diff.kept.find(({ slot }) => slot.extensionId === extId('200'));
    expect(sales.line.id).toBe(asLines(before.priya)[1].id);
    expect(sales.line.position).toBe(2);
    expect(sales.slot.position).toBe(3);

    expect(change(before.desk, slotsFor(s, 'rob-desk')).changed).toBe(false);
    expect(change(before.home, slotsFor(s, 'rob-home')).changed).toBe(false);

    // The label follows the extension, not whose phone it is on.
    const index = indexSnapshot(s);
    const phone = { ...index.phones.get('priya-desk'), labelChars: 20 };
    expect(labelFor(index, phone, ext(2, '100'))).toBe('Rob Parkinson 100');
  });

  test('a phone with three lines overflows to "Other"', () => {
    const s = baseSnapshot();
    addPhone(s, { id: 'ellie-desk', capacity: 3, people: ['ellie'] });
    const before = slotsFor(s, 'ellie-desk');
    expect(before).toEqual([ext(1, '105'), ext(2, '200'), ext(3, '210')]);

    setKeyPosition(s, 'ellie', 'warehouse', 3);
    const after = slotsFor(s, 'ellie-desk');
    expect(after).toEqual([ext(1, '105'), ext(2, '200'), other(3, ['210', '230'])]);

    const c = change(before, after);
    expect(c.removed).toEqual([extId('210')]);
    expect(c.added).toEqual(['other']);
    expect(c.moved).toEqual([]);
    expect(c.accountsCreated).toBe(1);
    expect(c.accountsRemoved).toBe(1);

    // A fourth shared extension only widens what "Other" covers.
    setKeyPosition(s, 'ellie', 'returns', 4);
    const later = slotsFor(s, 'ellie-desk');
    expect(later).toEqual([ext(1, '105'), ext(2, '200'), other(3, ['210', '230', '240'])]);
    const c2 = change(after, later);
    expect(c2.accountsCreated).toBe(0);
    expect(c2.accountsRemoved).toBe(0);
    expect(c2.moved).toEqual([]);
    expect(c2.coverChanged).toBe(true);
    expect(c2.changed).toBe(true);
  });

  test('a one-line phone moves between its own extension and "Other"', () => {
    const s = baseSnapshot();
    s.extensions.push({ id: extId('106'), number: '106', type: 'ring_all', entryId: 'tom' });
    addPhone(s, { id: 'tom-dect', capacity: 1, people: ['tom'] });

    const added = slotsFor(s, 'tom-dect');
    expect(added).toEqual([ext(1, '106')]);
    const c1 = change([], added);
    expect([c1.accountsCreated, c1.accountsRemoved]).toEqual([1, 0]);

    setKeyPosition(s, 'tom', 'support', 1);
    const joined = slotsFor(s, 'tom-dect');
    expect(joined).toEqual([other(1, ['106', '210'])]);
    const c2 = change(added, joined);
    expect(c2.removed).toEqual([extId('106')]);
    expect(c2.added).toEqual(['other']);
    expect([c2.accountsCreated, c2.accountsRemoved]).toEqual([1, 1]);

    removeMember(s, 'tom', extId('210'));
    const left = slotsFor(s, 'tom-dect');
    expect(left).toEqual([ext(1, '106')]);
    const c3 = change(joined, left);
    expect(c3.removed).toEqual(['other']);
    expect(c3.added).toEqual([extId('106')]);
    expect([c3.accountsCreated, c3.accountsRemoved]).toEqual([1, 1]);

    // A second person is not allowed on a one-line phone.
    expect(maxPeople(1)).toBe(1);
  });

  test('a membership is added', () => {
    const s = baseSnapshot();
    addPhone(s, { id: 'rob-desk', capacity: 12, people: ['rob'] });
    addPhone(s, { id: 'rob-home', capacity: 8, people: ['rob'] });
    addPhone(s, { id: 'rob-mobile', kind: 'external', capacity: 0, people: ['rob'] });
    const before = ['rob-desk', 'rob-home', 'rob-mobile'].map((id) => slotsFor(s, id));

    setKeyPosition(s, 'rob', 'returns', 3);
    const after = ['rob-desk', 'rob-home', 'rob-mobile'].map((id) => slotsFor(s, id));
    const expected = [ext(1, '100'), ext(2, '200'), ext(3, '210'), ext(4, '240')];
    expect(after[0]).toEqual(expected);
    expect(after[1]).toEqual(expected);
    expect(after[2]).toEqual([]);

    const changes = before.map((b, i) => change(b, after[i]));
    expect(changes[0].added).toEqual([extId('240')]);
    expect(changes[1].added).toEqual([extId('240')]);
    expect(changes[2].changed).toBe(false);
    expect(changes.reduce((n, c) => n + c.accountsCreated, 0)).toBe(2);
    expect(changes.every((c) => c.moved.length === 0 && c.removed.length === 0)).toBe(true);
  });

  test('a membership is removed from a full shared phone', () => {
    const s = baseSnapshot();
    addPhone(s, { id: 'warehouse', capacity: 6, people: ['sam', 'mo'] });
    const before = slotsFor(s, 'warehouse');
    expect(before).toEqual([
      ext(1, '103'), ext(2, '104'), ext(3, '200'), ext(4, '210'), ext(5, '230'), other(6, ['240', '250']),
    ]);

    removeMember(s, 'sam', extId('200'));
    const after = slotsFor(s, 'warehouse');
    expect(after).toEqual([
      ext(1, '103'), ext(2, '104'), ext(3, '210'), ext(4, '230'), ext(5, '240'), ext(6, '250'),
    ]);

    const c = change(before, after);
    expect(c.removed).toEqual([extId('200'), 'other'].sort());
    expect(c.added).toEqual([extId('240'), extId('250')]);
    expect(c.moved).toEqual([extId('210'), extId('230')]);
    expect(c.accountsCreated).toBe(2);
    expect(c.accountsRemoved).toBe(2);
  });

  test('a change of key order moves lines and keeps accounts', () => {
    const s = baseSnapshot();
    addPhone(s, { id: 'rob-desk', capacity: 12, people: ['rob'] });
    addPhone(s, { id: 'rob-home', capacity: 8, people: ['rob'] });
    const before = ['rob-desk', 'rob-home'].map((id) => slotsFor(s, id));

    setKeyPosition(s, 'rob', 'support', 1);
    setKeyPosition(s, 'rob', 'sales', 2);
    const after = ['rob-desk', 'rob-home'].map((id) => slotsFor(s, id));
    for (const slots of after) expect(slots).toEqual([ext(1, '100'), ext(2, '210'), ext(3, '200')]);

    const changes = before.map((b, i) => change(b, after[i]));
    expect(changes.reduce((n, c) => n + c.moved.length, 0)).toBe(4);
    expect(changes.reduce((n, c) => n + c.accountsCreated + c.accountsRemoved, 0)).toBe(0);
    for (const c of changes) expect(c.moved).toEqual([extId('200'), extId('210')]);
  });

  test('the people on a shared phone are re-ordered', () => {
    const s = baseSnapshot();
    removeMember(s, 'sam', extId('200'));
    addPhone(s, { id: 'warehouse', capacity: 6, people: ['sam', 'mo'] });
    const before = slotsFor(s, 'warehouse');
    expect(before).toEqual([
      ext(1, '103'), ext(2, '104'), ext(3, '210'), ext(4, '230'), ext(5, '240'), ext(6, '250'),
    ]);

    s.phonePeople = [
      { phoneId: 'warehouse', entryId: 'mo', position: 1 },
      { phoneId: 'warehouse', entryId: 'sam', position: 2 },
    ];
    const after = slotsFor(s, 'warehouse');
    expect(after).toEqual([
      ext(1, '104'), ext(2, '103'), ext(3, '210'), ext(4, '230'), ext(5, '240'), ext(6, '250'),
    ]);

    const c = change(before, after);
    expect(c.moved).toEqual([extId('103'), extId('104')]);
    expect(c.accountsCreated + c.accountsRemoved).toBe(0);
  });

  test('a shared extension becomes a connection once its members are removed', () => {
    const s = baseSnapshot();
    addPhone(s, { id: 'rob-desk', capacity: 12, people: ['rob'] });
    addPhone(s, { id: 'rob-home', capacity: 8, people: ['rob'] });
    addPhone(s, { id: 'jane-desk', capacity: 8, people: ['jane'] });
    addPhone(s, { id: 'warehouse', capacity: 6, people: ['sam', 'mo'] });
    addPhone(s, { id: 'ellie-desk', capacity: 3, people: ['ellie'] });
    addPhone(s, { id: 'priya-desk', capacity: 8, people: ['priya'] });
    const phoneIds = s.phones.map((p) => p.id);
    const before = Object.fromEntries(phoneIds.map((id) => [id, slotsFor(s, id)]));

    for (const person of ['rob', 'jane', 'sam', 'mo', 'ellie']) removeMember(s, person, extId('210'));
    setType(s, extId('210'), 'connection');
    const after = Object.fromEntries(phoneIds.map((id) => [id, slotsFor(s, id)]));

    const support = extId('210');
    const covers = (slots) => slots.some((slot) => slot.extensionId === support || (slot.covers || []).includes(support));
    for (const id of phoneIds) expect(covers(after[id])).toBe(false);

    for (const id of ['rob-desk', 'rob-home', 'jane-desk', 'warehouse', 'ellie-desk']) {
      expect(change(before[id], after[id]).removed).toContain(support);
    }
    expect(change(before['priya-desk'], after['priya-desk']).changed).toBe(false);
    // Keys after the Support key move up.
    expect(after['rob-desk']).toEqual([ext(1, '100'), ext(2, '200')]);
    expect(after['jane-desk']).toEqual([ext(1, '102')]);
    expect(after['ellie-desk']).toEqual([ext(1, '105'), ext(2, '200')]);
    expect(after.warehouse).toEqual([
      ext(1, '103'), ext(2, '104'), ext(3, '200'), ext(4, '230'), ext(5, '240'), ext(6, '250'),
    ]);
  });
});

// Direct input to workOutLines, for the rules that do not need a whole directory.
const e = (id, type = 'ring_all') => ({ id, type });
const input = ({ capacity = 12, kind = 'deskphone', people = [], owned = {}, memberOf = {} }) => ({
  phone: { id: 'p', kind, capacity },
  people: people.map((entryId, i) => ({ entryId, position: i + 1 })),
  owned: new Map(Object.entries(owned)),
  memberOf: new Map(Object.entries(memberOf).map(([k, list]) => [k, list.map(([extension, keyPosition]) => ({ extension, keyPosition }))])),
});
const ids = (slots) => slots.map((slot) => (slot.kind === 'other' ? ['other', ...slot.covers] : slot.extensionId));

describe('order of keys', () => {
  test('owned extensions come before shared ones whatever the key positions', () => {
    const slots = workOutLines(input({
      people: ['a', 'b'],
      owned: { a: e('A'), b: e('B') },
      memberOf: { a: [[e('S1'), 0], [e('S2'), -5]] },
    }));
    expect(ids(slots)).toEqual(['A', 'B', 'S2', 'S1']);
  });

  test('people are taken in position order, not list order', () => {
    const i = input({ people: ['a', 'b'], owned: { a: e('A'), b: e('B') } });
    i.people = [{ entryId: 'b', position: 2 }, { entryId: 'a', position: 1 }];
    expect(ids(workOutLines(i))).toEqual(['A', 'B']);
  });

  test('all of the first person\'s shared keys come before the second\'s, and duplicates are placed once', () => {
    const slots = workOutLines(input({
      people: ['a', 'b'],
      owned: { a: e('A'), b: e('B') },
      memberOf: {
        a: [[e('X'), 2], [e('Y'), 1]],
        b: [[e('Z'), 1], [e('Y'), 2], [e('W'), 3]],
      },
    }));
    expect(ids(slots)).toEqual(['A', 'B', 'Y', 'X', 'Z', 'W']);
    expect(slots.map((slot) => slot.position)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('an extension owned by one person and shared by another takes one key, at the owned position', () => {
    const s = baseSnapshot();
    s.members.push({ extensionId: extId('100'), entryId: 'priya', huntPosition: 2, keyPosition: 1 });
    addPhone(s, { id: 'shared', capacity: 12, people: ['priya', 'rob'] });
    expect(slotsFor(s, 'shared')).toEqual([
      ext(1, '101'), ext(2, '100'), ext(3, '200'), ext(4, '210'),
    ]);
  });

  test('"Other" covers its extensions in priority order', () => {
    const s = baseSnapshot();
    setKeyPosition(s, 'ellie', 'deliveries', 3);
    setKeyPosition(s, 'ellie', 'returns', 4);
    setKeyPosition(s, 'ellie', 'warehouse', 5);
    addPhone(s, { id: 'ellie-desk', capacity: 3, people: ['ellie'] });
    expect(slotsFor(s, 'ellie-desk')).toEqual([
      ext(1, '105'), ext(2, '200'), other(3, ['210', '250', '240', '230']),
    ]);
  });
});

describe('types that take a key', () => {
  test('the ringing types are ring_all, hunt and queue', () => {
    expect([...RINGING_TYPES].sort()).toEqual(['hunt', 'queue', 'ring_all']);
  });

  test.each(['ring_all', 'hunt', 'queue'])('a %s extension takes a key', (type) => {
    const s = baseSnapshot();
    setType(s, extId('200'), type);
    setType(s, extId('100'), type);
    addPhone(s, { id: 'rob-desk', capacity: 12, people: ['rob'] });
    expect(slotsFor(s, 'rob-desk')).toEqual([ext(1, '100'), ext(2, '200'), ext(3, '210')]);
  });

  test.each(['connection', 'forward', 'agent'])('a %s extension takes no key', (type) => {
    const s = baseSnapshot();
    setType(s, extId('200'), type);
    setType(s, extId('100'), type);
    addPhone(s, { id: 'rob-desk', capacity: 12, people: ['rob'] });
    expect(slotsFor(s, 'rob-desk')).toEqual([ext(1, '210')]);
  });
});

describe('capacity edges', () => {
  const shared = (n) => Array.from({ length: n }, (_, i) => [e(`S${i + 1}`), i + 1]);

  test('as many extensions as lines needs no "Other"', () => {
    const slots = workOutLines(input({ capacity: 3, people: ['a'], owned: { a: e('A') }, memberOf: { a: shared(2) } }));
    expect(ids(slots)).toEqual(['A', 'S1', 'S2']);
  });

  test('one extension more than lines gives an "Other" that covers two', () => {
    const slots = workOutLines(input({ capacity: 3, people: ['a'], owned: { a: e('A') }, memberOf: { a: shared(3) } }));
    expect(slots).toEqual([
      { position: 1, kind: 'extension', extensionId: 'A' },
      { position: 2, kind: 'extension', extensionId: 'S1' },
      { position: 3, kind: 'other', covers: ['S2', 'S3'] },
    ]);
  });

  test('a one-line phone with one extension has an extension line', () => {
    const slots = workOutLines(input({ capacity: 1, people: ['a'], owned: { a: e('A') } }));
    expect(slots).toEqual([{ position: 1, kind: 'extension', extensionId: 'A' }]);
  });

  test('a one-line phone with two extensions has one "Other" that covers both', () => {
    const slots = workOutLines(input({ capacity: 1, people: ['a'], owned: { a: e('A') }, memberOf: { a: shared(1) } }));
    expect(slots).toEqual([{ position: 1, kind: 'other', covers: ['A', 'S1'] }]);
  });

  test('a two-line phone with one person and three extensions', () => {
    const slots = workOutLines(input({ capacity: 2, people: ['a'], owned: { a: e('A') }, memberOf: { a: shared(2) } }));
    expect(slots).toEqual([
      { position: 1, kind: 'extension', extensionId: 'A' },
      { position: 2, kind: 'other', covers: ['S1', 'S2'] },
    ]);
  });

  test('an outside number has no lines, whatever capacity it is given', () => {
    const slots = workOutLines(input({ kind: 'external', capacity: 12, people: ['a'], owned: { a: e('A') } }));
    expect(slots).toEqual([]);
  });

  test('a browser phone has lines', () => {
    const slots = workOutLines(input({ kind: 'browser', capacity: 50, people: ['a'], owned: { a: e('A') }, memberOf: { a: shared(2) } }));
    expect(ids(slots)).toEqual(['A', 'S1', 'S2']);
  });

  test('a phone that rings for nobody has no lines', () => {
    expect(workOutLines(input({ capacity: 12 }))).toEqual([]);
    const s = baseSnapshot();
    addPhone(s, { id: 'spare', capacity: 12 });
    expect(slotsFor(s, 'spare')).toEqual([]);
  });
});

describe('line identity across a change', () => {
  test('identity is the extension, or "other" for the overflow line', () => {
    expect(lineIdentity({ kind: 'extension', extensionId: 'X' })).toBe('X');
    expect(lineIdentity({ kind: 'other', covers: ['X'] })).toBe('other');
  });

  test('a moved line keeps its id, endpoint and line number', () => {
    const current = [
      { id: 'L1', position: 1, kind: 'extension', extensionId: 'A', lineNumber: 7, endpointId: 'E1' },
      { id: 'L2', position: 2, kind: 'extension', extensionId: 'B', lineNumber: 8, endpointId: 'E2' },
    ];
    const diff = diffLines(current, [
      { position: 1, kind: 'extension', extensionId: 'B' },
      { position: 2, kind: 'extension', extensionId: 'A' },
    ]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.moved).toHaveLength(2);
    const b = diff.kept.find(({ slot }) => slot.extensionId === 'B');
    expect(b.line).toMatchObject({ id: 'L2', lineNumber: 8, endpointId: 'E2' });
    expect(b.slot.position).toBe(1);
  });

  test('a line whose extension moves into "Other" is removed and "Other" is created', () => {
    const current = [
      { id: 'L1', position: 1, kind: 'extension', extensionId: 'A' },
      { id: 'L2', position: 2, kind: 'extension', extensionId: 'B' },
    ];
    const diff = diffLines(current, [
      { position: 1, kind: 'extension', extensionId: 'A' },
      { position: 2, kind: 'other', covers: ['B', 'C'] },
    ]);
    expect(diff.removed.map((l) => l.id)).toEqual(['L2']);
    expect(diff.added.map(lineIdentity)).toEqual(['other']);
    expect(diff.moved).toEqual([]);
  });

  test('when "Other" goes, its line is removed', () => {
    const current = [
      { id: 'L1', position: 1, kind: 'extension', extensionId: 'A' },
      { id: 'L2', position: 2, kind: 'other', covers: ['B', 'C'] },
    ];
    const diff = diffLines(current, [
      { position: 1, kind: 'extension', extensionId: 'A' },
      { position: 2, kind: 'extension', extensionId: 'B' },
    ]);
    expect(diff.removed.map((l) => l.id)).toEqual(['L2']);
    expect(diff.added.map(lineIdentity)).toEqual(['B']);
  });

  test('the same slots again change nothing', () => {
    const slots = [
      { position: 1, kind: 'extension', extensionId: 'A' },
      { position: 2, kind: 'other', covers: ['B', 'C'] },
    ];
    const diff = diffLines(asLines(slots), slots);
    expect(diff.changed).toBe(false);
    expect(diff.coverChanged).toBe(false);
  });
});

describe('labels', () => {
  test('an owned line shows the name and the number', () => {
    expect(lineLabel({ kind: 'extension', number: '100', name: 'Rob Parkinson', personal: true, labelChars: 20 }))
      .toBe('Rob Parkinson 100');
  });

  test('a cut keeps the number: first name, initial, number', () => {
    expect(lineLabel({ kind: 'extension', number: '100', name: 'Rob Parkinson', personal: true, labelChars: 10 }))
      .toBe('Rob P. 100');
  });

  test('a cut falls back to the number alone', () => {
    expect(lineLabel({ kind: 'extension', number: '100', name: 'Rob Parkinson', personal: true, labelChars: 6 }))
      .toBe('100');
  });

  test('a shared line shows the extension\'s name, cut to the key', () => {
    expect(lineLabel({ kind: 'extension', number: '200', name: 'Sales', personal: false, labelChars: 12 })).toBe('Sales');
    const cut = lineLabel({ kind: 'extension', number: '250', name: 'Deliveries', personal: false, labelChars: 6 });
    expect(cut.length).toBeLessThanOrEqual(6);
    expect('Deliveries'.startsWith(cut)).toBe(true);
    expect(cut.length).toBeGreaterThan(0);
  });

  test('"Other" shows the brand word', () => {
    expect(lineLabel({ kind: 'other', labelChars: 12 })).toBe('Other');
    expect(lineLabel({ kind: 'other', labelChars: 12, otherWord: 'More calls' })).toBe('More calls');
  });

  test('labels from the directory', () => {
    const s = baseSnapshot();
    addPhone(s, { id: 'short', capacity: 3, labelChars: 10, people: ['rob'] });
    addPhone(s, { id: 'long', capacity: 12, labelChars: 20, people: ['rob'] });
    const index = indexSnapshot(s);
    const short = index.phones.get('short');
    const long = index.phones.get('long');
    expect(labelFor(index, long, ext(1, '100'))).toBe('Rob Parkinson 100');
    expect(labelFor(index, short, ext(1, '100'))).toBe('Rob P. 100');
    expect(labelFor(index, long, ext(2, '200'))).toBe('Sales');
    expect(labelFor(index, long, other(3, ['210']))).toBe('Other');
    expect(labelFor(index, long, other(3, ['210']), 'More')).toBe('More');
  });
});

describe('how many people a phone may ring for', () => {
  test.each([[12, 11], [8, 7], [6, 5], [3, 2], [2, 1], [1, 1]])('capacity %i takes %i', (capacity, people) => {
    expect(maxPeople(capacity)).toBe(people);
  });

  test('at the limit, no shared extension can push an owned extension into "Other"', () => {
    for (const capacity of [2, 3, 6, 12]) {
      const n = maxPeople(capacity);
      const people = Array.from({ length: n }, (_, i) => `p${i}`);
      const owned = Object.fromEntries(people.map((p) => [p, e(`own-${p}`)]));
      for (const sharedCount of [0, 1, 5, 20]) {
        const memberOf = Object.fromEntries(people.map((p) => [p, Array.from({ length: sharedCount }, (_, i) => [e(`S${i}`), i + 1])]));
        const slots = workOutLines(input({ capacity, people, owned, memberOf }));
        const overflow = slots.find((slot) => slot.kind === 'other');
        for (const p of people) {
          expect(overflow?.covers || []).not.toContain(`own-${p}`);
          expect(slots.some((slot) => slot.extensionId === `own-${p}`)).toBe(true);
        }
      }
    }
  });
});

describe('indexing a snapshot', () => {
  test('rows that hang off missing rows are ignored', () => {
    const s = baseSnapshot();
    s.extensions.push({ id: 'ext-900', number: '900', type: 'ring_all', entryId: 'gone' });
    s.members.push({ extensionId: 'ext-900', entryId: 'rob', huntPosition: 1, keyPosition: 3 });
    s.members.push({ extensionId: 'ext-missing', entryId: 'rob', huntPosition: 1, keyPosition: 4 });
    s.members.push({ extensionId: extId('230'), entryId: 'gone', huntPosition: 1, keyPosition: 1 });
    addPhone(s, { id: 'rob-desk', capacity: 12, people: ['rob'] });
    s.phonePeople.push({ phoneId: 'rob-desk', entryId: 'gone', position: 2 });
    s.phonePeople.push({ phoneId: 'no-phone', entryId: 'rob', position: 1 });

    const index = indexSnapshot(s);
    expect(index.extensions.has('ext-900')).toBe(false);
    expect(index.extensionByNumber.has('900')).toBe(false);
    expect((index.membersByExtension.get(extId('230')) || []).map((m) => m.entryId)).not.toContain('gone');
    expect(index.membershipsByEntry.has('gone')).toBe(false);
    expect(index.membershipsByEntry.get('rob').map((m) => m.extension.id)).toEqual([extId('200'), extId('210')]);
    expect(index.peopleByPhone.get('rob-desk').map((p) => p.entryId)).toEqual(['rob']);
    expect(index.peopleByPhone.has('no-phone')).toBe(false);
    expect(index.phonesByEntry.get('rob').map((p) => p.id)).toEqual(['rob-desk']);

    expect(slotsFor(s, 'rob-desk')).toEqual([ext(1, '100'), ext(2, '200'), ext(3, '210')]);
  });

  test('an owner\'s own member row is not a shared key', () => {
    const index = indexSnapshot(baseSnapshot());
    expect(index.membershipsByEntry.get('rob').map((m) => m.extension.id)).not.toContain(extId('100'));
    expect(ownedExtension(index, 'rob').id).toBe(extId('100'));
    expect(ownedExtension(index, 'sales')).toBeUndefined();
  });
});

describe('snapshot look-ups', () => {
  test('the line that carries an extension, and the number it calls as', () => {
    const s = baseSnapshot();
    addPhone(s, { id: 'ellie-desk', capacity: 2, people: ['ellie'] });
    s.lines = [
      { id: 'L1', phoneId: 'ellie-desk', position: 1, kind: 'extension', extensionId: extId('105'), lineNumber: 1 },
      { id: 'L2', phoneId: 'ellie-desk', position: 2, kind: 'other', covers: [extId('200'), extId('210')], lineNumber: 2 },
    ];
    s.organisation.mainNumber = '+442079460000';
    s.numbers = [{ number: '+442079460105', extensionId: extId('105') }];
    const index = indexSnapshot(s);
    expect(lineForExtension(index, 'ellie-desk', extId('105')).id).toBe('L1');
    expect(lineForExtension(index, 'ellie-desk', extId('210')).id).toBe('L2');
    expect(lineForExtension(index, 'ellie-desk', extId('230'))).toBeNull();
    // Calls out from "Other" use the first person's own extension.
    expect(callingExtension(index, index.lineById.get('L2')).id).toBe(extId('105'));
    expect(shownNumber(index, index.extensions.get(extId('105')))).toEqual({ number: '+442079460105', source: 'only' });
    expect(shownNumber(index, index.extensions.get(extId('200')))).toEqual({ number: '+442079460000', source: 'main' });
  });
});

describe('phone models', () => {
  test('MAC addresses are normalised', () => {
    expect(normaliseMac('00:04:13:AB:CD:EF')).toBe('000413abcdef');
    expect(normaliseMac('0004.13ab.cdef')).toBe('000413abcdef');
    expect(normaliseMac('00-04-13-ab-cd-ef')).toBe('000413abcdef');
    expect(normaliseMac('000413abcde')).toBeNull();
    expect(normaliseMac('000413abcdeg')).toBeNull();
    expect(normaliseMac(null)).toBeNull();
  });

  test('Snom MAC addresses are recognised', () => {
    expect(isSnomMac('000413abcdef')).toBe(true);
    expect(isSnomMac('001565abcdef')).toBe(false);
  });

  test('a model is found whatever its case, and an unknown one is null', () => {
    const known = phoneModel('snom', 'D785');
    expect(known).not.toBeNull();
    expect(phoneModel('SNOM', 'd785')).toEqual(known);
    expect(phoneModel('snom', 'X999')).toBeNull();
    expect(phoneModel('acme', 'D785')).toBeNull();
  });

  test('the reported model wins over the typed one, and an outside number has no lines', () => {
    const big = phoneModel('snom', 'D785').lines;
    const small = phoneModel('snom', 'D717').lines;
    expect(big).not.toBe(small);
    expect(phoneCapacity({ kind: 'deskphone' }, { vendor: 'snom', model: 'D785' })).toBe(big);
    expect(phoneCapacity({ kind: 'deskphone' }, { vendor: 'snom', model: 'D785', reportedModel: 'D717' })).toBe(small);
    expect(phoneCapacity({ kind: 'external' }, { vendor: 'snom', model: 'D785' })).toBe(0);
    expect(phoneCapacity({ kind: 'external' })).toBe(0);
  });
});
