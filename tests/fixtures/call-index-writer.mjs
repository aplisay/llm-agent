// Creates calls from a SEPARATE process, all at once, for
// tests/call-index-concurrency.test.mjs.
//
// Usage: node tests/fixtures/call-index-writer.mjs '<json>'
//   json = { organisationId, userId, instanceId, count }
//
// Connects with the POSTGRES_* variables it is given, fires `count` Call
// creates concurrently through the real model (so the beforeCreate hook that
// numbers them runs here), prints the indexes it was given as one JSON line,
// and exits 0. Any failure exits non-zero with the error on stderr.
const spec = JSON.parse(process.argv[2] || '{}');

try {
  const { Call, databaseStarted, stopDatabase } = await import('../../lib/database.js');
  await databaseStarted;
  const calls = await Promise.all(Array.from({ length: spec.count || 0 }, () => Call.create({
    organisationId: spec.organisationId,
    userId: spec.userId,
    instanceId: spec.instanceId,
    platform: 'test',
    calledId: '441000000000',
    callerId: '441000000001',
  })));
  console.log(JSON.stringify({ indexes: calls.map((c) => c.index) }));
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
