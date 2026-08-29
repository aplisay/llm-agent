#!/usr/bin/env node
// Credentials-at-rest audit / sweep for a legacy database (one created while
// CREDENTIALS_KEY was empty, so credentials were stored as raw plaintext).
//
//   node tools/credentials-audit.js [--path .env] [--json]     read-only audit
//   node tools/credentials-audit.js --sweep [--path .env]      encrypt plaintext in place, then re-audit
//
// Connects directly with the POSTGRES_* environment (no model sync, no
// listener, nothing written in audit mode), so it is safe to run against a
// live legacy instance BEFORE deploying anything. Without CREDENTIALS_KEY in
// the environment the audit still runs, but encrypted values can only be
// reported as encrypted-unverified (the GCM tag cannot be checked) and
// --sweep is refused. Credential values are never printed or logged.
//
// Exit codes: 0 = every stored credential verified encrypted under the
// current key; 1 = findings (plaintext / lookalike / foreign / unverified /
// non-string, or a location that errored); 2 = usage or connection error.
import dotenv from 'dotenv';
import dir from 'path';
import commandLineArgs from 'command-line-args';

const optionDefinitions = [
  { name: 'path', alias: 'p', type: String },
  { name: 'json', alias: 'j', type: Boolean },
  { name: 'sweep', alias: 's', type: Boolean },
  { name: 'help', alias: 'h', type: Boolean },
];
const options = commandLineArgs(optionDefinitions);
if (options.help) {
  console.log('Usage: node tools/credentials-audit.js [--path <.env>] [--json] [--sweep]');
  process.exit(0);
}
dotenv.config(options.path ? { path: dir.resolve(process.cwd(), options.path) } : {});

// Import AFTER dotenv: lib/utils/credentials.js captures CREDENTIALS_KEY at load.
const { Sequelize } = await import('sequelize');
const { auditStoredCredentials, sweepPlaintextCredentials } = await import('../lib/utils/credentials-sweep.js');
const { hasCredentialsKey } = await import('../lib/utils/credentials.js');

const {
  POSTGRES_DB, POSTGRES_USER, POSTGRES_HOST, POSTGRES_PASSWORD, POSTGRES_PORT,
  POSTGRES_KEY, POSTGRES_CERT, POSTGRES_CA, POSTGRES_RO_SERVER_NAME,
} = process.env;

const sequelize = new Sequelize(POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD, {
  dialect: 'postgres',
  host: POSTGRES_HOST,
  port: POSTGRES_PORT,
  dialectOptions: POSTGRES_CA ? {
    ssl: { ca: POSTGRES_CA, key: POSTGRES_KEY, cert: POSTGRES_CERT, servername: POSTGRES_RO_SERVER_NAME },
  } : {},
  logging: false,
});

const CLEAN_CLASSES = new Set(['encrypted', 'empty']);

function printAudit(report) {
  console.log(`Credentials-at-rest audit  (CREDENTIALS_KEY: ${report.hasCredentialsKey ? 'present' : 'ABSENT — encrypted values cannot be verified'})`);
  console.log('');
  let findings = 0;
  for (const loc of report.locations) {
    const counts = Object.entries(loc.counts)
      .map(([cls, n]) => `${cls} ${n}`)
      .join('   ');
    console.log(`  ${loc.label.padEnd(32)} total ${String(loc.total).padEnd(6)} ${counts}`);
    for (const [cls, ids] of Object.entries(loc.anomalies)) {
      console.log(`    ${cls} ids: ${ids.join(', ')}${loc.counts[cls] > ids.length ? ` … (${loc.counts[cls]} total)` : ''}`);
    }
    if (loc.error) console.log(`    ERROR: ${loc.error}`);
    findings += Object.entries(loc.counts)
      .filter(([cls]) => !CLEAN_CLASSES.has(cls))
      .reduce((sum, [, n]) => sum + n, 0);
    findings += loc.error ? 1 : 0;
  }
  console.log('');
  if (findings) {
    console.log(`Findings: ${findings} value(s) not verified encrypted under the current key.`);
    if (report.locations.some((l) => l.counts.plaintext)) {
      console.log('Run this tool with --sweep to encrypt plaintext values in place.');
    }
  } else {
    console.log('Clean: every stored credential verified encrypted under the current key.');
  }
  return findings;
}

const hasFindings = (report) => report.locations.some((l) =>
  l.error || Object.keys(l.counts).some((cls) => !CLEAN_CLASSES.has(cls)));

let exitCode = 0;
try {
  if (options.sweep && !hasCredentialsKey) {
    console.error('--sweep requires CREDENTIALS_KEY in the environment; refusing.');
    exitCode = 2;
  } else {
    const summary = options.sweep ? await sweepPlaintextCredentials(sequelize) : null;
    const report = await auditStoredCredentials(sequelize);
    if (options.json) {
      console.log(JSON.stringify(summary ? { sweep: summary, audit: report } : report, null, 2));
      exitCode = hasFindings(report) ? 1 : 0;
    } else {
      for (const loc of summary?.locations || []) {
        if (loc.candidates || loc.error) {
          console.log(`Sweep ${loc.label}: ${loc.updated} encrypted, ${loc.skipped} skipped${loc.error ? `, ERROR: ${loc.error}` : ''}`);
        }
      }
      if (summary) console.log('');
      exitCode = printAudit(report) ? 1 : 0;
    }
  }
} catch (err) {
  console.error(`Audit failed: ${err?.message}`);
  exitCode = 2;
}
await sequelize.close().catch(() => {});
process.exit(exitCode);
