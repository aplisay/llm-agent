// Boots lib/database.js in a SEPARATE process, for tests/boot-lock.test.mjs:
// what a server does on start, and nothing else. Prints "started" once the
// boot chain has run and exits 0; any failure exits non-zero with the error
// on stderr.
try {
  const { databaseStarted, stopDatabase } = await import('../../lib/database.js');
  await databaseStarted;
  process.stdout.write('started\n');
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
