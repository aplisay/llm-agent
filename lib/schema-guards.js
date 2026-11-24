/**
 * Schema steps that wait for `tools/agent-admin.js upgrade-db`
 * (docs/self-hosting/upgrading.md). Each entry lists the tables and columns
 * its step adds. At boot lib/database.js reads `information_schema` for them
 * and changes nothing. A step that is not all there is off: its columns are
 * left out of the models, so every other read of those models still works,
 * and its feature refuses requests until the upgrade and a restart.
 *
 * This module reads no database, so anything may import it.
 */
export const GUARDED_STEPS = {
  registrarHA1: {
    version: 72,
    tables: [],
    columns: { phone_registrations: ['ha1', 'previous_ha1', 'previous_ha1_until'] },
  },
  phoneSystem: {
    version: 73,
    tables: [
      'directory_entries', 'extensions', 'extension_members', 'devices', 'phones', 'phone_people',
      'phone_rules', 'lines', 'phone_changes', 'call_events',
    ],
    columns: {
      organisations: ['capabilities', 'address', 'main_number', 'busy_status_visible', 'outbound_policy'],
      phone_numbers: [
        'extension_id', 'emergency_address_mode', 'emergency_address', 'emergency_record_state',
        'emergency_record_reason', 'emergency_record_updated_at',
      ],
    },
  },
  brands: {
    version: 74,
    tables: ['brands'],
    columns: { organisations: ['brand'], auth_keys: ['brand'] },
  },
  phoneProvisioning: {
    version: 76,
    tables: ['device_fetch_logs'],
    columns: {
      devices: [
        'token_expires_at', 'token_used_at', 'certificate_fingerprint', 'certificate_serial', 'certificate_issuer',
        'line_limit',
      ],
    },
  },
  outboundPolicy: {
    version: 77,
    tables: ['outbound_events'],
    columns: { brands: ['outbound_ceiling'] },
  },
  callRedaction: {
    version: 78,
    tables: [],
    columns: { calls: ['redacted_at', 'redacted_by'] },
  },
  phoneResync: {
    version: 80,
    tables: [],
    columns: { devices: ['resync_version', 'resync_requested_at', 'resync_attempts', 'resync_state'] },
  },
};

const stepsOff = new Set();

/** Every table the guarded steps add or change. */
export function guardedTables() {
  const tables = Object.values(GUARDED_STEPS).flatMap((step) => [...step.tables, ...Object.keys(step.columns)]);
  return [...new Set(tables)];
}

/** The tables and `table.column` names of a step that these `information_schema.columns` rows lack. */
export function missingParts(step, rows) {
  const tables = new Set(rows.map((r) => r.table_name));
  const columns = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const { tables: stepTables, columns: stepColumns } = GUARDED_STEPS[step];
  return [
    ...stepTables.filter((table) => !tables.has(table)),
    ...Object.entries(stepColumns)
      .flatMap(([table, names]) => names.map((name) => `${table}.${name}`))
      .filter((column) => !columns.has(column)),
  ];
}

export function stepOff(step) {
  stepsOff.add(step);
}

export function stepReady(step) {
  return !stepsOff.has(step);
}

/** The names in an explicit attribute list that the model still has. */
export function presentAttributes(model, names) {
  const have = typeof model?.getAttributes === 'function' ? model.getAttributes() : null;
  return have ? names.filter((name) => name in have) : names;
}
