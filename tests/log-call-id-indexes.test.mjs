import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

// transaction_logs and invocation_logs are read per call (GET /calls/{id}/logs
// and /invocation-log, lib/call-hook.js) by call_id, which Postgres does not
// index for a foreign key on its own. Schema 67 builds the index concurrently
// in the gated upgrade chain; this checks it is there, and valid, after a
// DB_FORCE_SYNC boot, and that the migration repairs an invalid leftover.
describe('call_id indexes on the per-call log tables', () => {
  let sequelize;
  let migrate;
  let expected;

  const q = (sql) => sequelize.query(sql);

  const indexState = async (index) => {
    const [[row]] = await q(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i
        WHERE i.indexrelid = to_regclass('public.${index}')`,
    );
    return row || null;
  };

  beforeAll(async () => {
    const db = await setupRealDatabase();
    sequelize = db.models.TransactionLog.sequelize;
    ({ migrateLogCallIdIndexes: migrate, LOG_CALL_ID_INDEXES: expected } = await import('../lib/database.js'));
  }, 60000);

  afterAll(async () => {
    await teardownRealDatabase();
  });

  test('both indexes exist and are valid after startup', async () => {
    expect(expected.map((e) => e.table).sort()).toEqual(['invocation_logs', 'transaction_logs']);
    for (const { table, index } of expected) {
      const state = await indexState(index);
      expect(state).not.toBeNull();
      expect(state.valid).toBe(true);
      expect(state.def).toBe(`CREATE INDEX ${index} ON public.${table} USING btree (call_id)`);
    }
  });

  test('the migration is a no-op on a database that already has them', async () => {
    const before = await Promise.all(expected.map(({ index }) => q(
      `SELECT c.oid FROM pg_class c WHERE c.oid = to_regclass('public.${index}')`,
    ).then(([[row]]) => row.oid)));
    await migrate();
    await migrate();
    const after = await Promise.all(expected.map(({ index }) => q(
      `SELECT c.oid FROM pg_class c WHERE c.oid = to_regclass('public.${index}')`,
    ).then(([[row]]) => row.oid)));
    // Same relation oids: nothing was dropped and rebuilt.
    expect(after).toEqual(before);
  });

  test('an invalid index left by an interrupted build is dropped and rebuilt', async () => {
    const { index } = expected[0];
    // What a CREATE INDEX CONCURRENTLY that died mid-way leaves behind.
    await q(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass('public.${index}')`);
    expect((await indexState(index)).valid).toBe(false);
    await migrate();
    expect((await indexState(index)).valid).toBe(true);
  });
});
