/**
 * The schema steps that wait for upgrade-db, and what the boot decides from
 * `information_schema.columns`. lib/database.js applies it.
 */
import { GUARDED_STEPS, guardedTables, missingParts, stepOff, stepReady, presentAttributes } from '../lib/schema-guards.js';

/** The rows an upgraded database gives for every guarded table and column. */
function upgradedRows() {
  return Object.values(GUARDED_STEPS).flatMap((step) => [
    ...step.tables.map((table) => ({ table_name: table, column_name: 'id' })),
    ...Object.entries(step.columns).flatMap(([table, names]) => names.map((name) => ({ table_name: table, column_name: name }))),
  ]);
}

describe('guarded schema steps', () => {
  test('registrar HA1, the phone system, brands, phone provisioning, the outbound policy and the extension charge, in version order', () => {
    expect(Object.entries(GUARDED_STEPS).map(([name, step]) => [name, step.version]))
      .toEqual([['registrarHA1', 72], ['phoneSystem', 73], ['brands', 74], ['phoneProvisioning', 76], ['outboundPolicy', 77], ['extensionCharge', 78]]);
  });

  test('a schema 75 database lacks the provisioning step, and its features stay off', () => {
    const rows = upgradedRows().filter((row) => row.table_name !== 'device_fetch_logs' && !(row.table_name === 'devices' && row.column_name !== 'id'));
    expect(missingParts('phoneSystem', [...rows, { table_name: 'devices', column_name: 'id' }])).toEqual([]);
    expect(missingParts('phoneProvisioning', rows)).toEqual([
      'device_fetch_logs', 'devices.token_expires_at', 'devices.token_used_at', 'devices.certificate_fingerprint',
      'devices.certificate_serial', 'devices.certificate_issuer', 'devices.line_limit',
    ]);
  });

  test('a schema 76 database lacks the outbound policy step, and the earlier steps are all there', () => {
    const rows = upgradedRows().filter((row) => row.table_name !== 'outbound_events' && !(row.table_name === 'brands' && row.column_name === 'outbound_ceiling'));
    for (const step of ['registrarHA1', 'phoneSystem', 'brands', 'phoneProvisioning']) expect(missingParts(step, rows)).toEqual([]);
    expect(missingParts('outboundPolicy', rows)).toEqual(['outbound_events', 'brands.outbound_ceiling']);
  });

  test('a schema 77 database lacks only the extension charge step', () => {
    const rows = upgradedRows().filter((row) => !(row.table_name === 'organisations' && row.column_name === 'charge_unpaid_since'));
    for (const step of ['registrarHA1', 'phoneSystem', 'brands', 'phoneProvisioning', 'outboundPolicy']) expect(missingParts(step, rows)).toEqual([]);
    expect(missingParts('extensionCharge', rows)).toEqual(['organisations.charge_unpaid_since']);
  });

  test('the boot reads each table a step adds or changes, once', () => {
    const tables = guardedTables();
    expect(new Set(tables).size).toBe(tables.length);
    for (const table of ['phone_registrations', 'organisations', 'phone_numbers', 'auth_keys', 'brands', 'lines', 'call_events', 'outbound_events']) {
      expect(tables).toContain(table);
    }
  });

  test('nothing is missing on an upgraded database', () => {
    for (const step of Object.keys(GUARDED_STEPS)) expect(missingParts(step, upgradedRows())).toEqual([]);
  });

  test('a schema 71 database lacks every part of all three steps', () => {
    const rows = [
      { table_name: 'organisations', column_name: 'id' },
      { table_name: 'phone_numbers', column_name: 'number' },
      { table_name: 'phone_registrations', column_name: 'password' },
      { table_name: 'auth_keys', column_name: 'key' },
    ];
    expect(missingParts('registrarHA1', rows)).toEqual(['phone_registrations.ha1', 'phone_registrations.previous_ha1', 'phone_registrations.previous_ha1_until']);
    expect(missingParts('phoneSystem', rows)).toEqual(expect.arrayContaining(['lines', 'call_events', 'organisations.capabilities', 'phone_numbers.extension_id']));
    expect(missingParts('brands', rows)).toEqual(['brands', 'organisations.brand', 'auth_keys.brand']);
  });

  test('one missing part is enough', () => {
    const rows = upgradedRows().filter((r) => !(r.table_name === 'phone_numbers' && r.column_name === 'emergency_address'));
    expect(missingParts('phoneSystem', rows)).toEqual(['phone_numbers.emergency_address']);
    expect(missingParts('registrarHA1', rows)).toEqual([]);
  });
});

describe('steps switched off at boot', () => {
  test('a step is on until switched off, and each step is apart', () => {
    expect(stepReady('phoneSystem')).toBe(true);
    stepOff('phoneSystem');
    expect(stepReady('phoneSystem')).toBe(false);
    expect(stepReady('brands')).toBe(true);
  });

  test('an explicit attribute list keeps only what the model still has', () => {
    const model = { getAttributes: () => ({ id: {}, name: {} }) };
    expect(presentAttributes(model, ['id', 'name', 'capabilities', 'brand'])).toEqual(['id', 'name']);
    expect(presentAttributes({}, ['id', 'brand'])).toEqual(['id', 'brand']);
  });
});
