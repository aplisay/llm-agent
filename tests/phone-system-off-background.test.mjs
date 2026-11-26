import { jest } from '@jest/globals';

/**
 * Phone system code that runs outside its routes, on a database without the
 * phone system schema steps: the extension check in every outbound
 * authorisation, and the daily purge. Neither may read the missing tables.
 */
const missingTable = async () => { throw new Error('relation does not exist'); };
const table = { findOne: missingTable, findAll: missingTable, destroy: missingTable };

jest.unstable_mockModule('../lib/database.js', () => ({
  Trunk: {}, Organisation: {}, User: {}, RateCard: {}, Tariff: {}, TariffPrefix: {}, UsageRecord: {},
  Call: {}, Brand: {}, OutboundEvent: table,
  Extension: table, DirectoryEntry: table, ExtensionMember: table, PhonePerson: table, Line: table, PhoneNumber: table,
  Op: { ne: Symbol('ne'), lt: Symbol('lt'), or: Symbol('or') },
  databaseStarted: Promise.resolve(),
}));
jest.unstable_mockModule('../lib/rates.js', () => ({ resolveEffectiveRateCard: async () => null }));

const { stepOff } = await import('../lib/schema-guards.js');
const { internalExtensionDialled } = await import('../lib/outbound-authorisation.js');
const { purgeRemoved } = await import('../lib/pbx/purge.js');

const extension = { id: 'x1', number: '201', type: 'ring_all', entryId: null };
const found = { Extension: { findOne: async () => extension }, DirectoryEntry: table };

test('with the phone system on, the outbound check finds an extension', async () => {
  expect(await internalExtensionDialled({ organisationId: 'o1', dialled: '201' }, found)).toBe(extension);
});

describe('with the phone system off', () => {
  beforeAll(() => stepOff('phoneSystem'));

  test('the outbound check finds no extension, and reads nothing', async () => {
    expect(await internalExtensionDialled({ organisationId: 'o1', dialled: '201' }, found)).toBeNull();
    expect(await internalExtensionDialled({ organisationId: 'o1', dialled: '201' })).toBeNull();
  });

  test('the purge removes nothing, and reads nothing', async () => {
    expect(await purgeRemoved()).toEqual({ entries: 0, extensions: 0 });
  });
});
