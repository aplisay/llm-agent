import { mergeMemberFunctions, isKeyedFunction } from '../lib/agent-set-functions.js';

/**
 * Pure merge semantics for keyed (platform-wired) function preservation on
 * agent-set saves — the DB-backed end-to-end behaviour is covered in
 * agent-sets.test.mjs; this file pins the shape handling and edge cases.
 */

const keyed = (name, extra = {}) => ({
  name,
  implementation: 'rest',
  method: 'post',
  url: `https://integrations.example.com/v1/tools/${name}`,
  key: 'POLITE_BOOKING',
  ...extra
});
const plain = (name) => ({ name, implementation: 'rest', method: 'get', url: 'https://api.example.com/x' });

describe('isKeyedFunction', () => {
  test('true only for a non-empty string key', () => {
    expect(isKeyedFunction(keyed('a'))).toBe(true);
    expect(isKeyedFunction(plain('a'))).toBe(false);
    expect(isKeyedFunction({ name: 'a', key: '' })).toBe(false);
    expect(isKeyedFunction({ name: 'a', key: 42 })).toBe(false);
    expect(isKeyedFunction(null)).toBe(false);
  });
});

describe('mergeMemberFunctions', () => {
  test('keyed functions omitted by the document are appended; unkeyed are dropped', () => {
    const prior = [plain('old_tool'), keyed('booking_get_slots'), keyed('booking_book')];
    const incoming = [plain('new_tool')];
    const merged = mergeMemberFunctions(prior, incoming);
    expect(merged.map((f) => f.name)).toEqual(['new_tool', 'booking_get_slots', 'booking_book']);
  });

  test('an incoming function of the same name wins over the stored keyed one', () => {
    const prior = [keyed('booking_book', { description: 'stored' })];
    const incoming = [keyed('booking_book', { description: 'incoming' })];
    const merged = mergeMemberFunctions(prior, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('incoming');
  });

  test('removeFunctions deletes a keyed function the document omits', () => {
    const prior = [keyed('booking_get_slots'), keyed('booking_book')];
    const merged = mergeMemberFunctions(prior, [plain('t')], ['booking_book']);
    expect(merged.map((f) => f.name)).toEqual(['t', 'booking_get_slots']);
  });

  test('no incoming functions and no removals leaves the field untouched', () => {
    expect(mergeMemberFunctions([keyed('a')], undefined)).toBeUndefined();
    expect(mergeMemberFunctions([keyed('a')], undefined, [])).toBeUndefined();
    expect(mergeMemberFunctions(undefined, undefined, ['a'])).toBeUndefined();
    expect(mergeMemberFunctions(null, undefined, ['a'])).toBeUndefined();
  });

  test('remove-only (no functions supplied) deletes by name, keyed or not, keeping shape', () => {
    const prior = [plain('a'), keyed('b'), keyed('c')];
    expect(mergeMemberFunctions(prior, undefined, ['a', 'c']).map((f) => f.name)).toEqual(['b']);

    const priorObj = { a: plain('a'), b: keyed('b') };
    expect(mergeMemberFunctions(priorObj, undefined, ['a'])).toEqual({ b: keyed('b') });
  });

  test('object-shaped stored functions are preserved into an array-shaped document, gaining a name', () => {
    // Entries stored keyed-by-name may carry no inner name — an array entry must.
    const { name: _n, ...nameless } = keyed('booking_book');
    const prior = { booking_book: nameless };
    const merged = mergeMemberFunctions(prior, [plain('t')]);
    expect(merged.map((f) => f.name)).toEqual(['t', 'booking_book']);
    expect(merged[1].key).toBe('POLITE_BOOKING');
  });

  test('object-shaped documents gain preserved entries as named keys', () => {
    const prior = [keyed('booking_book')];
    const merged = mergeMemberFunctions(prior, { t: plain('t') });
    expect(Object.keys(merged).sort()).toEqual(['booking_book', 't']);
    expect(merged.booking_book.key).toBe('POLITE_BOOKING');
  });

  test('name matching spans shapes: an object-keyed incoming entry beats a stored array entry', () => {
    const prior = [keyed('booking_book', { description: 'stored' })];
    const merged = mergeMemberFunctions(prior, { booking_book: keyed('booking_book', { description: 'incoming' }) });
    expect(Object.keys(merged)).toEqual(['booking_book']);
    expect(merged.booking_book.description).toBe('incoming');
  });

  test('an empty incoming array still preserves keyed functions (and only those)', () => {
    const prior = [plain('a'), keyed('b')];
    expect(mergeMemberFunctions(prior, []).map((f) => f.name)).toEqual(['b']);
  });

  test('explicit removal plus empty incoming empties the member', () => {
    const prior = [keyed('booking_get_slots'), keyed('booking_book')];
    expect(mergeMemberFunctions(prior, [], ['booking_get_slots', 'booking_book'])).toEqual([]);
  });

  test('tolerates junk entries without throwing', () => {
    const merged = mergeMemberFunctions([null, 'bogus', keyed('b')], [undefined, plain('t')]);
    expect(merged.filter((f) => f && f.name).map((f) => f.name)).toEqual(['t', 'b']);
  });
});
