/**
 * First-boot bootstrap for a self-hosted instance: one organisation, one user
 * and one API key, so the operator can call the API without Firebase or
 * better-auth. See docs/running.md, "First API key".
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { User, Organisation, AuthKey, databaseStarted } from './database.js';

// Any fixed 64-bit value, different from BOOT_LOCK_KEY in lib/boot-lock.js.
const BOOTSTRAP_LOCK_KEY = '4207189273618255202';

// auth_keys.key is a varchar(255) and the key travels in an Authorization header.
const KEY_PATTERN = /^[\x21-\x7e]{32,255}$/;

export class BootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export function generateKey() {
  return randomBytes(32).toString('base64url');
}

/** Throws a BootstrapError when an operator-supplied key cannot be used. */
export function validateKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new BootstrapError('the API key must be 32 to 255 printable characters with no spaces');
  }
  // middleware/auth.js reads a bearer token whose base64 decodes to
  // "instance:..." as a room join token, never as an API key.
  let decoded = '';
  try { decoded = atob(key); } catch { /* not base64: fine */ }
  if (decoded.startsWith('instance:')) {
    throw new BootstrapError('the API key must not decode to an "instance:" token');
  }
}

/**
 * Create the first organisation, user and API key. Does nothing once any user
 * exists, so it cannot add an operator to a database that is already in use.
 *
 * @param {{ key?: string, organisationName?: string, userName?: string, email?: string }} [options]
 * @returns {Promise<{ created: true, key: string, userId: string, organisationId: string }
 *   | { created: false, reason: 'users-exist' }>}
 */
export async function bootstrap({ key, organisationName = 'Default organisation', userName = 'Operator', email = null } = {}) {
  await databaseStarted;
  const result = await User.sequelize.transaction(async (transaction) => {
    // Replicas that start together on an empty database must not each create an operator.
    await User.sequelize.query('SELECT pg_advisory_xact_lock(:lock)', {
      replacements: { lock: BOOTSTRAP_LOCK_KEY },
      transaction,
    });
    if (await User.findOne({ attributes: ['id'], transaction })) {
      return { created: false, reason: 'users-exist' };
    }
    // Validated only now: a stale value left in the environment of a database
    // that already has users must not stop that server booting.
    if (key !== undefined) validateKey(key);
    const apiKey = key ?? generateKey();

    const organisation = await Organisation.create(
      { id: randomUUID(), name: organisationName, status: 'active' },
      { transaction },
    );
    // superAdmin: a self-hoster operates the platform (trunks, numbers, rate
    // cards), which an organisation owner may not set up.
    const user = await User.create({
      id: randomUUID(),
      name: userName,
      email,
      emailVerified: false,
      role: 'superAdmin',
      status: 'active',
      signupMethod: 'bootstrap',
      organisationId: organisation.id,
    }, { transaction });
    await AuthKey.create({ key: apiKey, userId: user.id, roleRestriction: null }, { transaction });
    return { created: true, key: apiKey, userId: user.id, organisationId: organisation.id };
  });
  // A request that tried this key before the row existed left a negative cache entry.
  if (result.created) AuthKey.cachedKeys.delete(result.key);
  return result;
}

let settled = Promise.resolve();

/**
 * Resolves once every bootstrap started from BOOTSTRAP_API_KEY has finished.
 * The server listens before its database is ready, so a request that carries
 * the bootstrap key can arrive before the key exists. The auth middleware
 * waits on this instead of answering 401.
 */
export function bootstrapSettled() {
  return settled;
}

/**
 * Server start-up hook: bootstrap from BOOTSTRAP_API_KEY when it is set,
 * otherwise say how to get a key if the database has no users yet.
 */
export function bootstrapFromEnv({ log, env = process.env } = {}) {
  const run = runFromEnv({ log, env });
  // Set in the caller's tick, before any request can be handled.
  if (env.BOOTSTRAP_API_KEY) settled = Promise.allSettled([settled, run]);
  return run;
}

async function runFromEnv({ log, env }) {
  await databaseStarted;
  const key = env.BOOTSTRAP_API_KEY;
  if (!key) {
    if (!(await User.findOne({ attributes: ['id'] }))) {
      log?.warn('no users exist yet: run `yarn bootstrap` to create the first API key, or set BOOTSTRAP_API_KEY and restart');
    }
    return { created: false, reason: 'not-requested' };
  }
  const result = await bootstrap({ key });
  if (result.created) {
    log?.info(
      { userId: result.userId, organisationId: result.organisationId },
      'bootstrap: created the first organisation, user and API key from BOOTSTRAP_API_KEY',
    );
  }
  return result;
}
