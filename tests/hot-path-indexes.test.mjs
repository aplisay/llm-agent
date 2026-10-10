import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

// Schema 68: the per-call and per-request reads on calls, usage_records,
// users and chat_sessions that scanned the table (see the HOT_PATH_INDEXES
// comments in lib/database.js). Same concurrent build as the schema 67 log
// indexes; this checks every index is there and valid after a DB_FORCE_SYNC
// boot, that its definition is the intended one, and that the migration
// repairs an invalid leftover without touching valid indexes.
describe('hot-path indexes', () => {
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

  const oids = () => Promise.all(expected.map(({ index }) => q(
    `SELECT c.oid FROM pg_class c WHERE c.oid = to_regclass('public.${index}')`,
  ).then(([[row]]) => row.oid)));

  beforeAll(async () => {
    const db = await setupRealDatabase();
    sequelize = db.models.Call.sequelize;
    ({ migrateHotPathIndexes: migrate, HOT_PATH_INDEXES: expected } = await import('../lib/database.js'));
  }, 60000);

  afterAll(async () => {
    await teardownRealDatabase();
  });

  test('every index exists, is valid and has the intended definition', async () => {
    const defs = {
      calls_organisation_id_index: 'CREATE INDEX calls_organisation_id_index ON public.calls USING btree (organisation_id, index)',
      calls_user_id_index: 'CREATE INDEX calls_user_id_index ON public.calls USING btree (user_id, index)',
      calls_platform_call_id: 'CREATE INDEX calls_platform_call_id ON public.calls USING btree (platform_call_id) WHERE (platform_call_id IS NOT NULL)',
      calls_parent_id: 'CREATE INDEX calls_parent_id ON public.calls USING btree (parent_id) WHERE (parent_id IS NOT NULL)',
      usage_records_unfinalised_updated_at: 'CREATE INDEX usage_records_unfinalised_updated_at ON public.usage_records USING btree (updated_at) WHERE (NOT finalised)',
      users_email: 'CREATE INDEX users_email ON public.users USING btree (email)',
      chat_sessions_open_owner: 'CREATE INDEX chat_sessions_open_owner ON public.chat_sessions USING btree (owner) WHERE (ended_at IS NULL)',
    };
    expect(expected.map((e) => e.index).sort()).toEqual(Object.keys(defs).sort());
    for (const { index } of expected) {
      const state = await indexState(index);
      expect(state).not.toBeNull();
      expect(state.valid).toBe(true);
      expect(state.def).toBe(defs[index]);
    }
  });

  test('the migration is a no-op on a database that already has them', async () => {
    const before = await oids();
    await migrate();
    await migrate();
    expect(await oids()).toEqual(before);
  });

  test('an invalid index left by an interrupted build is dropped and rebuilt, the rest untouched', async () => {
    const { index } = expected.find((e) => e.where);
    const before = await oids();
    await q(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass('public.${index}')`);
    expect((await indexState(index)).valid).toBe(false);
    await migrate();
    expect((await indexState(index)).valid).toBe(true);
    const after = await oids();
    const changed = expected.filter((_, i) => before[i] !== after[i]).map((e) => e.index);
    expect(changed).toEqual([index]);
  });

  test('the planner can serve the per-call MAX(index) from the organisation index', async () => {
    // The test table is empty, where a sequential scan is the cheaper plan, so
    // take that choice away: with seqscan off the planner must find an index
    // that answers the query, which is what this checks. (On a populated table it
    // is the Backward form with a LIMIT; on an empty one a plain aggregate.)
    const plan = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL enable_seqscan = off', { transaction });
      const [rows] = await sequelize.query(
        `EXPLAIN SELECT COALESCE(MAX(index), 0) + 1 FROM calls WHERE organisation_id = 'org-x'`,
        { transaction },
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toMatch(/Index Only Scan( Backward)? using calls_organisation_id_index/);
  });
});
