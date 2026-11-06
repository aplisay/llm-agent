#!/usr/bin/env node
/**
 * Create the first organisation, user and API key on a new database, and print
 * the key. Does nothing if any user already exists.
 *
 *   yarn bootstrap [--key <key>] [--org <name>] [--name <name>] [--email <address>] [-p <env file>]
 */
import commandLineArgs from 'command-line-args';
import { loadEnv } from './env.mjs';

const options = commandLineArgs([
  { name: 'key', alias: 'k', type: String },
  { name: 'org', alias: 'o', type: String },
  { name: 'name', alias: 'n', type: String },
  { name: 'email', alias: 'e', type: String },
  { name: 'path', alias: 'p', type: String },
]);

loadEnv();
// Keep the schema-sync log lines out of the way of the key.
process.env.LOGLEVEL ||= 'error';

// Imported after loadEnv(): lib/database.js reads its settings at load.
const { bootstrap, BootstrapError } = await import('../lib/bootstrap.js');
const { stopDatabase } = await import('../lib/database.js');

let exitCode = 0;
try {
  const result = await bootstrap({
    key: options.key,
    organisationName: options.org,
    userName: options.name,
    email: options.email,
  });
  if (result.created) {
    console.log(`Created organisation ${result.organisationId} and user ${result.userId}.`);
    console.log(`API key: ${result.key}`);
    console.log('Send it as "Authorization: Bearer <key>".');
  } else {
    console.log('This database already has users, so nothing was created.');
    console.log('To add a key for an existing user: node tools/agent-admin.js add-authkey --userId <id>');
  }
} catch (err) {
  console.error(err instanceof BootstrapError ? `Cannot bootstrap: ${err.message}` : err);
  exitCode = 1;
} finally {
  await stopDatabase();
}
process.exit(exitCode);
