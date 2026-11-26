// No test may open a connection to a host outside this machine. A call that
// has no stand-in (tests/setup/vendor-stand-ins.js) is refused here at once,
// the same way on every machine, whatever keys the environment holds.
//
// jest loads this file for each test file (setupFiles). global-setup.js also
// preloads it, through NODE_OPTIONS, into jest's workers and into the child
// processes that tests start. CommonJS, because --require takes nothing else.
//
// Set TEST_NETWORK_LOG to a file path to get one JSON line for each refusal.
const fs = require('node:fs');
const net = require('node:net');

const ORIGINAL = Symbol.for('aplisay.tests.socketConnect');

// The test database is the one host that may be another machine: the
// `postgres` service in docker-compose.ci.yml. Keep in step with
// tests/setup/test-db-config.js.
const databaseHosts = [
  process.env.TEST_POSTGRES_HOST,
  process.env.USE_CONTAINER_NETWORKING === 'true' ? 'postgres' : undefined,
].filter(Boolean).map((host) => host.toLowerCase());

function isLocal(host) {
  // No host means localhost to node.
  if (host === undefined || host === null || host === '') return true;
  const name = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost')
    || /^127\./.test(name) || name.startsWith('::ffff:127.')
    || name === '::1' || name === '::' || name === '0.0.0.0'
    || databaseHosts.includes(name);
}

// The same three call shapes node accepts: (options), (path) and (port, host).
// net.connect() and tls.connect() pass them on as one array.
function destination(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === 'object') return first;
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first };
  return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
}

const original = net.Socket.prototype.connect[ORIGINAL] || net.Socket.prototype.connect;

function connect(...args) {
  const { host, port, path } = destination(args);
  if (path || isLocal(host)) return original.apply(this, args);
  const error = new Error(
    `Tests must not connect to ${host}:${port}. `
    + 'A vendor call needs a stand-in: see tests/setup/vendor-stand-ins.js.',
  );
  error.code = 'ECONNREFUSED';
  if (process.env.TEST_NETWORK_LOG) {
    try {
      fs.appendFileSync(process.env.TEST_NETWORK_LOG, `${JSON.stringify({
        host, port, pid: process.pid, script: process.argv[1], stack: error.stack,
      })}\n`);
    } catch {
      // The refusal matters more than the log.
    }
  }
  process.nextTick(() => this.destroy(error));
  return this;
}

// Installed again on every load, on top of node's own function. jest tears
// down a test file's globals when the file ends, so the copy an earlier test
// file installed must not stay in use.
connect[ORIGINAL] = original;
net.Socket.prototype.connect = connect;
