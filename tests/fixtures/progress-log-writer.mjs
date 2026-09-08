// Writes transaction logs from a SEPARATE server process, for
// tests/progress-notify-cross-process.test.mjs.
//
// Usage: node tests/fixtures/progress-log-writer.mjs '<json>'
//   json = { logs: [{ callId, userId, organisationId, type, data, isFinal }] }
//
// Connects with the POSTGRES_* variables it is given, writes each log in
// order through the real model (so the afterCreate hook runs here, in a
// process that never saw the Call row being created), then closes the
// database and exits 0. Any failure exits non-zero with the error on stderr.
const spec = JSON.parse(process.argv[2] || '{}');

try {
  const { TransactionLog, databaseStarted, stopDatabase } = await import('../../lib/database.js');
  await databaseStarted;
  for (const log of spec.logs || []) {
    // eslint-disable-next-line no-await-in-loop
    await TransactionLog.create(log);
  }
  // Every write is committed, and NOTIFY goes out with the commit, so nothing
  // here waits on the reader. Close politely, but never hang the test on it.
  await Promise.race([
    stopDatabase(),
    new Promise((resolve) => { setTimeout(resolve, 5000).unref?.(); }),
  ]);
  process.exit(0);
}
catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
