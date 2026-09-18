import { QueryTypes } from 'sequelize';
import logger from '../logger.js';
import { classifyStoredSecret, encryptSecret, isEncryptedSecretFormat, hasCredentialsKey } from './credentials.js';

/**
 * Every place a credential is stored at rest under the CREDENTIALS_KEY scheme
 * (docs/security: encryptSecret/decryptSecret). Instances deployed before a
 * key was configured hold these as raw plaintext; the audit classifies them
 * and the sweep encrypts them in place.
 *
 * kind 'column': the column itself is the stored secret (text/varchar).
 * kind 'jsonb':  the secret is a nested string inside a JSONB column, at
 *                `path` (Postgres text[] path literal).
 */
export const CREDENTIAL_LOCATIONS = [
  { label: 'phone_registrations.password', table: 'phone_registrations', column: 'password', kind: 'column' },
  { label: 'calls.encryption_key', table: 'calls', column: 'encryption_key', kind: 'column' },
  { label: 'agents.options.recording.key', table: 'agents', column: 'options', kind: 'jsonb', path: '{recording,key}' },
  { label: 'instances.recording.key', table: 'instances', column: 'recording', kind: 'jsonb', path: '{key}' },
];

const PAGE_SIZE = 500;
const ANOMALY_ID_CAP = 50;

/** SQL expression for the stored secret's text value. */
const valueExpr = ({ kind, column, path }) =>
  kind === 'jsonb' ? `"${column}"#>>'${path}'` : `"${column}"`;

/**
 * Predicate selecting rows whose stored value is definitely plaintext: a
 * non-null string with no enc: prefix. enc:-prefixed values — including
 * structurally invalid lookalikes and foreign-key blobs — are deliberately
 * excluded: the sweep never rewrites a value it cannot classify beyond doubt
 * (the audit surfaces those instead). JSONB non-string values (never written
 * by encryptSecret) are likewise left alone.
 */
const plaintextPredicate = (location) => {
  const expr = valueExpr(location);
  const stringGuard = location.kind === 'jsonb'
    ? ` AND jsonb_typeof("${location.column}"#>'${location.path}') = 'string'`
    : '';
  return `${expr} IS NOT NULL AND ${expr} NOT LIKE 'enc:%'${stringGuard}`;
};

/**
 * Page rows as {id, value, jtype} ordered by id::text (uniform keyset cursor
 * for UUID and string ids). `jtype` is the underlying JSON type for jsonb
 * locations (null for plain columns): #>> stringifies every JSONB scalar, so
 * without it a nested number would masquerade as a plaintext string.
 */
async function* pageRows(sequelize, location, { where }) {
  const expr = valueExpr(location);
  const jtypeExpr = location.kind === 'jsonb'
    ? `jsonb_typeof("${location.column}"#>'${location.path}')`
    : 'NULL';
  let cursor = '';
  for (;;) {
    const rows = await sequelize.query(
      `SELECT "id", ${expr} AS value, ${jtypeExpr} AS jtype FROM "${location.table}"
         WHERE ${where} AND CAST("id" AS text) > :cursor
         ORDER BY CAST("id" AS text) LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { cursor, limit: PAGE_SIZE } },
    );
    if (!rows.length) return;
    yield rows;
    cursor = String(rows[rows.length - 1].id);
  }
}

/**
 * Read-only audit: classify every stored credential value at every location.
 * Never returns or logs the values themselves — only counts, and row ids for
 * the anomalous classes (enc-lookalike, encrypted-foreign, non-string).
 *
 * Without a CREDENTIALS_KEY in the environment, encrypted values report as
 * encrypted-unverified (structure checks still run; tag verification cannot).
 */
export async function auditStoredCredentials(sequelize) {
  const report = { hasCredentialsKey, locations: [] };
  for (const location of CREDENTIAL_LOCATIONS) {
    const expr = valueExpr(location);
    const entry = { label: location.label, total: 0, counts: {}, anomalies: {}, error: null };
    report.locations.push(entry);
    try {
      for await (const rows of pageRows(sequelize, location, { where: `${expr} IS NOT NULL` })) {
        for (const { id, value, jtype } of rows) {
          const cls = (location.kind === 'jsonb' && jtype !== 'string')
            ? 'non-string'
            : classifyStoredSecret(value);
          entry.total += 1;
          entry.counts[cls] = (entry.counts[cls] || 0) + 1;
          if (cls === 'enc-lookalike' || cls === 'encrypted-foreign' || cls === 'non-string') {
            const ids = (entry.anomalies[cls] ||= []);
            if (ids.length < ANOMALY_ID_CAP) ids.push(id);
          }
        }
      }
    } catch (err) {
      entry.error = err?.message;
      logger.warn({ location: location.label, err: err?.message }, 'credentials audit: location skipped');
    }
  }
  return report;
}

/**
 * Startup sweep: encrypt-in-place every definitely-plaintext credential, so a
 * legacy database created before CREDENTIALS_KEY was configured converges to
 * encrypted-at-rest on the first boot with a key. Idempotent (the predicate
 * matches nothing once swept) and cheap when clean: one count per location.
 *
 * Each row is updated with an optimistic `AND value = original` guard, so a
 * concurrent write wins and the row is skipped (a later boot re-sweeps it).
 * Rows are never deleted, values never logged, updated_at never bumped — the
 * readable value is identical before and after (plaintext passthrough vs
 * decrypt), only the at-rest form changes.
 */
export async function sweepPlaintextCredentials(sequelize) {
  if (!hasCredentialsKey) {
    logger.info('CREDENTIALS_KEY not set; skipping credentials-at-rest sweep');
    return { swept: false, locations: [] };
  }
  const summary = { swept: true, locations: [] };
  for (const location of CREDENTIAL_LOCATIONS) {
    const entry = { label: location.label, candidates: 0, updated: 0, skipped: 0, error: null };
    summary.locations.push(entry);
    try {
      const where = plaintextPredicate(location);
      const [{ count }] = await sequelize.query(
        `SELECT CAST(count(*) AS int) AS count FROM "${location.table}" WHERE ${where}`,
        { type: QueryTypes.SELECT },
      );
      if (!count) continue;
      entry.candidates = count;
      logger.info({ location: location.label, count }, 'Encrypting legacy plaintext credentials at rest');

      const updateSql = location.kind === 'jsonb'
        ? `UPDATE "${location.table}"
             SET "${location.column}" = jsonb_set("${location.column}", '${location.path}', to_jsonb(CAST(:enc AS text)))
           WHERE "id" = :id AND ${plaintextPredicate(location)} AND ${valueExpr(location)} = :orig`
        : `UPDATE "${location.table}" SET "${location.column}" = :enc
           WHERE "id" = :id AND ${valueExpr(location)} = :orig`;

      for await (const rows of pageRows(sequelize, location, { where })) {
        for (const { id, value } of rows) {
          if (classifyStoredSecret(value) !== 'plaintext') { entry.skipped += 1; continue; }
          const enc = encryptSecret(value);
          if (!isEncryptedSecretFormat(enc)) { entry.skipped += 1; continue; }
          const [, meta] = await sequelize.query(updateSql, { replacements: { id, enc, orig: value } });
          const changed = meta?.rowCount ?? meta ?? 0;
          if (changed) entry.updated += 1; else entry.skipped += 1;
        }
      }
      logger.info(
        { location: location.label, updated: entry.updated, skipped: entry.skipped },
        'Credentials-at-rest sweep complete for location',
      );
    } catch (err) {
      entry.error = err?.message;
      logger.warn({ location: location.label, err: err?.message }, 'credentials sweep: location skipped');
    }
  }
  return summary;
}
