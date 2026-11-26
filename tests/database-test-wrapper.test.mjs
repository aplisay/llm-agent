import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

// A beforeAll that times out leaves setupRealDatabase() running. The suite's
// afterAll must still close the database. A boot left to finish on its own
// connects after jest has torn the suite's environment down, and the error
// from that lands in whichever suite the worker runs next.
describe('test database wrapper', () => {
  test('teardown waits for a boot that is still in flight, then closes it', async () => {
    const boot = setupRealDatabase(); // not awaited, as after a hook timeout
    await teardownRealDatabase();

    const db = await boot;
    await expect(db.models.Organisation.sequelize.query('SELECT 1')).rejects.toThrow(/closed/);
  }, 60000);
});
