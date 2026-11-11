import { configStatus } from '../../lib/config-status.js';
import { buildInfo } from '../../lib/build-info.js';

// Unauthenticated, so cache the database check: a flood of probes must not
// become a flood of queries.
const DB_CHECK_TTL_MS = 5000;
const DB_CHECK_TIMEOUT_MS = 2000;
let dbCheck = { at: 0, result: null };

async function checkDatabase() {
  if (dbCheck.result && Date.now() - dbCheck.at < DB_CHECK_TTL_MS) return dbCheck.result;
  let result;
  try {
    const { User } = await import('../../lib/database.js');
    let timer;
    await Promise.race([
      User.sequelize.query('SELECT 1'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), DB_CHECK_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    result = { ok: true };
  } catch (err) {
    result = { ok: false, error: err.message === 'timed out' ? 'timed out' : 'unreachable' };
  }
  dbCheck = { at: Date.now(), result };
  return result;
}

// Whether a b2bua registration node has sent a heartbeat lately. Registering
// to a PBX or a carrier, and the trace and probe tools, need one.
const NODE_CHECK_TTL_MS = 30000;
let nodeCheck = { at: 0, enabled: false };

async function sipRegistrationEnabled() {
  if (Date.now() - nodeCheck.at < NODE_CHECK_TTL_MS) return nodeCheck.enabled;
  let enabled = false;
  try {
    const { probeNodeFromRegistry } = await import('../../lib/regclient-facade.js');
    enabled = !!(await probeNodeFromRegistry());
  } catch {
    enabled = false;
  }
  nodeCheck = { at: Date.now(), enabled };
  return enabled;
}

export default function () {
  return { GET: health };
}

const health = async (req, res) => {
  const [database, status] = await Promise.all([checkDatabase(), configStatus()]);
  const { commit, tag } = buildInfo();
  const sipRegistration = { enabled: database.ok ? await sipRegistrationEnabled() : false };
  res.status(database.ok ? 200 : 503).json({
    status: database.ok ? 'ok' : 'degraded',
    build: { commit, tag },
    database,
    ...status,
    features: { ...status.features, sipRegistration },
  });
};

const componentList = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      enabled: { type: 'boolean' },
      missing: { type: 'array', items: { type: 'string' }, description: 'Names of the unset variables this needs.' },
    },
  },
};

health.apiDoc = {
  summary: 'Instance health and configuration',
  description: 'No authentication. Says whether the database answers, and which runtimes, providers and optional features are enabled. '
    + 'For a disabled one it names the unset variables. It never returns a value.',
  operationId: 'health',
  tags: ['Health'],
  security: [],
  responses: {
    200: {
      description: 'The instance is up and its database answers.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded'] },
              build: { type: 'object', properties: { commit: { type: 'string', nullable: true }, tag: { type: 'string', nullable: true } } },
              database: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
              runtimes: componentList,
              providers: componentList,
              speech: componentList,
              recording: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  backend: { type: 'string', enum: ['gcs', 's3', 'file'] },
                  reason: { type: 'string', description: 'Why recording is off.' },
                },
              },
              features: {
                type: 'object',
                description: 'Optional features, for a front end to show or hide.',
                properties: {
                  accounts: {
                    type: 'object',
                    description: 'Sign-in with an email and password (BETTER_AUTH_ENABLED).',
                    properties: { enabled: { type: 'boolean' } },
                  },
                  setBuilder: {
                    type: 'object',
                    description: 'The agent-set builder (builtin:set-builder). On when its model provider has a key.',
                    properties: {
                      enabled: { type: 'boolean' },
                      model: { type: 'string' },
                      missing: { type: 'array', items: { type: 'string' }, description: 'Names of the unset variables it needs.' },
                    },
                  },
                  sipRegistration: {
                    type: 'object',
                    description: 'Registration to a PBX or carrier, with trace and probe. On when a b2bua registration node is reporting.',
                    properties: { enabled: { type: 'boolean' } },
                  },
                },
              },
              warnings: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    503: { description: 'The database does not answer. The body has the same shape.' },
  },
};
