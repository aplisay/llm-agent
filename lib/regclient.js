/**
 * regclient node-API client.
 *
 * regclient is the Go registration B2BUA that replaces the FreeSWITCH stack in
 * aplisay-b2bua (see that repo's `docs/regclient-plan.md`). Each phone
 * registration is claimed by exactly one regclient node, and the claim is
 * recorded in `phone_registrations.b2bua_id` — the node's public IP address.
 * That column is the pointer the originate path already follows to route
 * outbound INVITEs, and it is what lets this API reach the one node that holds
 * the SIP traces and can run a live registration probe.
 *
 * This module owns everything about talking to a node: how the URL is built,
 * how the connection is authenticated and verified, and — importantly — which
 * hosts we are willing to dial at all. Routes in `api/paths/**` layer the
 * org-scoped authorisation on top and translate failures into HTTP responses.
 *
 * Security posture (decision #10 of the plan): source-restricted firewalls in
 * front, verified TLS from a private CA carried in the secretenv bundle, and a
 * static bearer token shared through the same bundle. Nothing here is a
 * substitute for the firewall; it is the layer of that onion we own.
 */

import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import axios from 'axios';

/** Trace representations regclient can render; passed through verbatim. */
export const TRACE_FORMATS = ['json', 'decode', 'pcap'];

/**
 * Formats the trace *index* offers.
 *
 * A whole trace runs to tens of kilobytes of SIP text, so the listing describes
 * what happened without carrying it: `decode` there would be exactly the fat
 * response the index exists to avoid, and belongs on a single transaction.
 * `pcap` stays whole-registration because "give me everything for Wireshark" is
 * a real request and a capture of one transaction rarely is.
 */
export const TRACE_INDEX_FORMATS = ['json', 'pcap'];

export const DEFAULT_API_PORT = 8443;
export const DEFAULT_PROXY_TIMEOUT_MS = 2000;

/**
 * Read a PEM blob from the environment. secretenv bundles frequently carry
 * certificates base64-encoded (single-line env values), so accept either a
 * literal PEM or a base64 wrapping of one.
 */
export function decodePem(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('-----BEGIN')) return trimmed.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    return decoded.includes('-----BEGIN') ? decoded : null;
  }
  catch (e) {
    return null;
  }
}

export const boolEnv = (value, dflt = false) => {
  if (value === undefined || value === null || value === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

/**
 * Build the node-API configuration from the environment. Called per request so
 * that a redeployed secretenv bundle takes effect without a restart of this
 * process being strictly required, and so tests can pass an explicit env.
 */
export function loadRegclientConfig(env = process.env) {
  const insecure = boolEnv(env.REGCLIENT_API_INSECURE, false);
  return {
    port: Number(env.REGCLIENT_API_PORT || DEFAULT_API_PORT),
    // Plain HTTP to a node is only ever reachable through the explicit insecure
    // escape hatch; a stray REGCLIENT_API_SCHEME must not silently disable TLS.
    scheme: insecure && env.REGCLIENT_API_SCHEME === 'http' ? 'http' : 'https',
    token: env.REGCLIENT_API_TOKEN || '',
    // The token this deployment used before the current one, for verification
    // only. Nodes accept two bearer tokens at once so rotation is add-new,
    // flip-caller, drop-old with no downtime; the facade held one, so the
    // moment it flipped, every outstanding probe handle stopped verifying and
    // turned into a 404 mid-watch. Optional, and never used to sign.
    tokenPrevious: env.REGCLIENT_API_TOKEN_PREVIOUS || '',
    caCert: decodePem(env.REGCLIENT_CA_CERT),
    insecure,
    timeoutMs: Number(env.TRACE_PROXY_TIMEOUT_MS || DEFAULT_PROXY_TIMEOUT_MS),
    // Optional belt-and-braces allowlist of node addresses. When set, only
    // these hosts may be dialled regardless of what `b2bua_id` says.
    allowedNodes: String(env.REGCLIENT_NODE_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Loopback/private node addresses are refused unless a deployment says
    // otherwise — compose and kind clusters legitimately need this.
    allowPrivateNodes: boolEnv(env.REGCLIENT_ALLOW_PRIVATE_NODES, false)
  };
}

/**
 * Is this a host we are prepared to send a bearer token to?
 *
 * `b2bua_id` is normally written by the node that claimed the row, but the
 * public `PUT /phone-endpoints/{id}` also permits writing it — that is the
 * per-registration migration lever. It therefore has to be treated as
 * caller-influenced input: an unvalidated value here would turn this facade
 * into an SSRF gadget that leaks the node token to an arbitrary host. Accept
 * only a bare IP literal or DNS name (no scheme, credentials, path or port
 * smuggling), and refuse the address ranges an attacker would actually want.
 */
export function assertNodeAddressAllowed(node, config) {
  const host = String(node || '').trim();
  if (!host) return { ok: false, reason: 'no node address' };
  if (/[/\\@?#\s]/.test(host)) return { ok: false, reason: 'malformed node address' };

  const { allowedNodes = [], allowPrivateNodes = false } = config || {};
  if (allowedNodes.length && !allowedNodes.includes(host)) {
    return { ok: false, reason: 'node not in REGCLIENT_NODE_ALLOWLIST' };
  }

  const ipVersion = net.isIP(host);
  if (!ipVersion) {
    // A DNS name: allowed (deployments may name nodes), but it must look like
    // one rather than a URL fragment or a port-bearing authority.
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host)) {
      return { ok: false, reason: 'malformed node address' };
    }
    if (host === 'localhost' && !allowPrivateNodes) {
      return { ok: false, reason: 'loopback node address' };
    }
    return { ok: true, host };
  }

  if (isBlockedAddress(host, ipVersion, allowPrivateNodes)) {
    return { ok: false, reason: 'node address not routable for this deployment' };
  }
  return { ok: true, host };
}

function isBlockedAddress(host, ipVersion, allowPrivateNodes) {
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map(Number);
    // Link-local (cloud metadata) is never acceptable, allowlist or not.
    if (a === 169 && b === 254) return true;
    if (allowPrivateNodes) return false;
    if (a === 0 || a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lower = host.toLowerCase();
  if (lower.startsWith('fe80')) return true; // link-local
  if (allowPrivateNodes) return false;
  if (lower === '::' || lower === '::1') return true;
  if (/^f[cd]/.test(lower)) return true; // unique-local
  return false;
}

/**
 * URL of a registration's trace index, or of one transaction within it.
 *
 * With no `transactionId` this addresses the listing; with one it addresses that
 * single exchange in full.
 */
export function buildTraceUrl({ node, registrationId, transactionId, format = 'json', since, debug = false }, config) {
  const { scheme, port } = config;
  const host = net.isIP(node) === 6 ? `[${node}]` : node;
  const path = transactionId
    ? `/debug/registrations/${encodeURIComponent(registrationId)}/trace/${encodeURIComponent(transactionId)}`
    : `/debug/registrations/${encodeURIComponent(registrationId)}/trace`;
  const url = new URL(`${scheme}://${host}:${port}${path}`);
  if (format && format !== 'json') url.searchParams.set('format', format);
  if (since) url.searchParams.set('since', String(since));
  if (debug) url.searchParams.set('debug', '1');
  return url.toString();
}

/**
 * Whether a trace request asked for the platform leg of each call.
 *
 * A bridged call has two legs: the customer's PBX or carrier on one side of
 * the node and the platform on the other. The node serves the customer's leg
 * by default — it is the one a customer can compare with their own logs, and
 * the other, shown unasked, reads as a second call — and adds the platform
 * leg, interleaved by timestamp, when `debug` is set. Query strings arrive as
 * text, and the OpenAPI layer may or may not have coerced them, so accept the
 * usual spellings of "yes".
 */
export function wantsDebugTrace(value) {
  if (value === true) return true;
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

/** URL of the probe collection, or of one probe / its event stream. */
export function buildProbeUrl({ node, probeId, registrationId, events = false }, config) {
  const { scheme, port } = config;
  const host = net.isIP(node) === 6 ? `[${node}]` : node;
  const path = probeId
    ? `/probe/${encodeURIComponent(probeId)}${events ? '/events' : ''}`
    : '/probe';
  const url = new URL(`${scheme}://${host}:${port}${path}`);
  // The node checks this against the registration the probe was actually
  // started for and 404s if they disagree. The facade already refuses a
  // mismatch, so this is the same check made twice by two processes that do
  // not have to trust each other — the node is the only party that knows for
  // certain which registration a probe id belongs to.
  if (registrationId) url.searchParams.set('registrationId', registrationId);
  return url.toString();
}

/**
 * An https agent that verifies the node certificate against the private CA
 * distributed in the secretenv bundle. regclient mints its own certificate at
 * boot for its `EXT_IP_ADDRESS`, so there is no public PKI in this path and no
 * per-node certificate chore — but also no excuse for skipping verification.
 */
export function createNodeAgent(config) {
  if (config.scheme === 'http') return undefined;
  if (config.caCert) {
    return new https.Agent({ ca: config.caCert, rejectUnauthorized: true, keepAlive: false });
  }
  if (config.insecure) {
    return new https.Agent({ rejectUnauthorized: false, keepAlive: false });
  }
  return new https.Agent({ rejectUnauthorized: true, keepAlive: false });
}

/**
 * Is this configuration usable at all? A missing token or CA is a deployment
 * error, and saying so plainly beats a puzzling 504.
 */
export function configurationProblem(config) {
  if (!config.token) return 'REGCLIENT_API_TOKEN is not configured';
  if (config.scheme === 'https' && !config.caCert && !config.insecure) {
    return 'REGCLIENT_CA_CERT is not configured';
  }
  return null;
}

/**
 * One request to a node, with a hard total timeout and no retries: a dead node
 * must produce a prompt, clean failure for the UI rather than a hung request.
 *
 * `requestImpl` is injected in tests; it defaults to axios, which is already a
 * dependency and gives us per-request agents, timeouts and stream responses.
 */
export async function nodeRequest({
  url,
  method = 'GET',
  data,
  responseType = 'json',
  config,
  node,
  requestImpl = axios.request,
  signal
}) {
  const agent = createNodeAgent(config);
  const request = {
    url,
    method,
    responseType,
    // A node we have never reached gets the discovery bound rather than the
    // full budget; see timeoutFor.
    timeout: node ? timeoutFor(node, config) : config.timeoutMs,
    // Interpret status ourselves so a 4xx from the node can be reported as
    // what it is rather than thrown as a transport failure.
    validateStatus: () => true,
    maxRedirects: 0,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: responseType === 'arraybuffer' ? 'application/octet-stream' : 'application/json'
    },
    ...(agent ? { httpsAgent: agent } : {}),
    ...(config.scheme === 'http' ? { httpAgent: new http.Agent({ keepAlive: false }) } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(signal ? { signal } : {})
  };

  try {
    const response = await requestImpl(request);
    // Getting an answer at all is the proof: a FreeSWITCH node has no HTTP
    // surface, and nothing else can present a certificate our own CA signed.
    // The status does not matter — a 401 or a 404 is still regclient.
    rememberNodeCapability(node, CAPABILITY_TRACE);
    return response;
  }
  catch (err) {
    rememberNodeCapability(node, capabilityFromFailure(err));
    throw err;
  }
}

/**
 * Map a node round-trip onto the facade's contract. Anything that is not a
 * clean answer from the node becomes a 504 carrying the node address, so the
 * dashboard can say *which* node is not answering.
 */
export function describeNodeFailure(err, node) {
  const code = err?.code || err?.cause?.code;
  const reason = code === 'ECONNABORTED' || code === 'ETIMEDOUT' ? 'timeout'
    : code === 'ECONNREFUSED' ? 'connection refused'
      : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'host unreachable'
        : code === 'ENOTFOUND' ? 'host not found'
          : /certificate|self.signed|CERT_|DEPTH_ZERO/i.test(String(err?.message || '')) ? 'TLS verification failed'
            : (err?.message || 'unknown error');
  return { error: 'trace unavailable', node, reason };
}

/**
 * Open a long-lived response stream from a node (the probe event stream).
 *
 * The short proxy timeout is the right discipline for a trace fetch but wrong
 * for server-sent events, which stay open for the life of the probe. So the
 * bound here is on *establishing* the stream: if the node has not sent
 * response headers within `timeoutMs` the attempt is abandoned, and after that
 * the stream lives until either end closes it. Implemented on node:https
 * rather than axios so that distinction is explicit.
 */
export function openNodeStream({ url, method = 'GET', config, requestImpl }) {
  const target = new URL(url);
  const isTls = target.protocol === 'https:';
  const impl = requestImpl || (isTls ? https.request : http.request);
  return new Promise((resolve, reject) => {
    const req = impl({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache'
      },
      ...(isTls ? { agent: createNodeAgent(config) } : {})
    }, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('node did not answer in time'), { code: 'ETIMEDOUT' }));
    }, config.timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

/**
 * How long a node's heartbeat is treated as current: about three missed beats.
 * Shared with the facade's capability check so "alive" means one thing.
 */
export const HEARTBEAT_FRESH_MS = 3 * 60 * 1000;

/**
 * The regclient node to probe an UNCLAIMED registration on, chosen from the
 * heartbeat registry: the least loaded node that has heartbeated recently,
 * ties broken by how many registrations it already holds, then by address so
 * the choice is stable. Only regclient nodes qualify — the FreeSWITCH stack
 * has no probe API — and a stale row says nothing about a node's health, so
 * it is skipped rather than trusted.
 *
 * Pure: takes the rows, returns an address or null. `probeNodeFromRegistry`
 * is the reading half.
 */
export function pickLeastLoadedNode(nodes, { now = Date.now() } = {}) {
  const fresh = (nodes || []).filter((n) => {
    if (!n || n.type !== 'regclient' || !n.nodeId || !n.lastSeenAt) return false;
    return now - new Date(n.lastSeenAt).getTime() <= HEARTBEAT_FRESH_MS;
  });
  if (!fresh.length) return null;
  const load = (n) => (typeof n.systemLoad === 'number' && Number.isFinite(n.systemLoad) ? n.systemLoad : Number.POSITIVE_INFINITY);
  fresh.sort((a, b) =>
    load(a) - load(b) ||
    (Number(a.registrations) || 0) - (Number(b.registrations) || 0) ||
    String(a.nodeId).localeCompare(String(b.nodeId)));
  return String(fresh[0].nodeId);
}

/**
 * Which node should answer a probe for this registration?
 *
 * A claimed row must be probed by its owner — that node holds the live
 * registration and can therefore reuse its canonical Contact instead of
 * creating a second binding at the PBX. An unclaimed row has no owner, so it
 * goes to the least loaded live regclient node in the heartbeat registry
 * (`probeNodeFromRegistry`). `REGCLIENT_PROBE_NODES` remains as an optional
 * OVERRIDE for deployments whose nodes cannot heartbeat — a compose or kind
 * cluster with no route back to llm-agent — and, when set, is chosen from
 * deterministically by registration id.
 */
export function selectProbeNode({ registrationId, claimedNode, env = process.env }) {
  const claimed = String(claimedNode || '').trim();
  if (claimed) return claimed;
  const pool = String(env.REGCLIENT_PROBE_NODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!pool.length) return null;
  let hash = 0;
  for (const ch of String(registrationId)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[hash % pool.length];
}

// ── Node capability ─────────────────────────────────────────────────────────
//
// Not every b2bua node serves traces. The FreeSWITCH stack has no HTTP surface
// at all, and during the migration both stacks run side by side against the
// same table — so `b2bua_id` points at a node that may or may not answer.
//
// The verdict is arrived at without asking anything extra, because the request
// itself already proves it: a node presenting a certificate our private CA
// signed is regclient, and nothing else can be. Reaching one at all is
// therefore the whole test, and it is cached so it is paid once rather than
// per request.
//
// The distinction matters as much as the speed. "This registration is served by
// a node running the older stack" is a different thing to say than "the node is
// not responding", and only one of them is worth paging anybody about.

const CAPABILITY_TRACE = 'regclient';
const CAPABILITY_NONE = 'unsupported';
const CAPABILITY_UNKNOWN = 'unknown';

export { CAPABILITY_TRACE, CAPABILITY_NONE, CAPABILITY_UNKNOWN };

// Positive verdicts are held long: a node does not change stack without a
// redeploy. Negative ones are held briefly, because migrating a node to
// regclient is exactly the moment somebody will go looking for its traces.
const DEFAULT_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_UNSUPPORTED_TTL_MS = 60 * 1000;

// Discovery is bounded much more tightly than a real request. A node that
// serves traces answers in milliseconds on the same network; one that does not
// either refuses instantly or, behind a firewall that drops rather than
// rejects, never answers at all. Waiting the full request budget to learn which
// is a cost with no upside.
const DEFAULT_DISCOVERY_TIMEOUT_MS = 750;

const capabilities = new Map();

/** Capability TTLs and the discovery timeout, from the environment. */
export function capabilityConfig(env = process.env) {
  return {
    ttlMs: Number(env.REGCLIENT_CAPABILITY_TTL_MS || DEFAULT_CAPABILITY_TTL_MS),
    unsupportedTtlMs: Number(env.REGCLIENT_UNSUPPORTED_TTL_MS || DEFAULT_UNSUPPORTED_TTL_MS),
    discoveryTimeoutMs: Number(env.REGCLIENT_DISCOVERY_TIMEOUT_MS || DEFAULT_DISCOVERY_TIMEOUT_MS)
  };
}

/** What we currently believe about a node. */
export function nodeCapability(node, { env = process.env, now = Date.now } = {}) {
  const entry = capabilities.get(node);
  if (!entry) return CAPABILITY_UNKNOWN;
  const { ttlMs, unsupportedTtlMs } = capabilityConfig(env);
  const ttl = entry.capability === CAPABILITY_TRACE ? ttlMs : unsupportedTtlMs;
  if (now() - entry.at > ttl) {
    capabilities.delete(node);
    return CAPABILITY_UNKNOWN;
  }
  return entry.capability;
}

/** Record what a round-trip told us. */
export function rememberNodeCapability(node, capability, { now = Date.now } = {}) {
  if (!node || capability === CAPABILITY_UNKNOWN) return;
  capabilities.set(node, { capability, at: now() });
}

/** Forget everything. Tests, and anything that wants to force re-discovery. */
export function resetNodeCapabilities() {
  capabilities.clear();
}

/**
 * How long to allow for a request to this node.
 *
 * A node we have already reached gets the full budget; one we have never
 * reached gets the discovery bound, so learning "this is a FreeSWITCH node"
 * costs a fraction of a second once rather than the whole timeout every time.
 */
export function timeoutFor(node, config, { env = process.env } = {}) {
  if (nodeCapability(node, { env }) === CAPABILITY_TRACE) return config.timeoutMs;
  return Math.min(config.timeoutMs, capabilityConfig(env).discoveryTimeoutMs);
}

/**
 * Read a failed round-trip as a statement about the node.
 *
 * The answer is now almost always CAPABILITY_UNKNOWN, and that is the point.
 *
 * A refused connection looks identical whether the address holds a FreeSWITCH
 * node with no HTTP surface at all or a regclient node that is simply down —
 * and the second is exactly when somebody wants to look. Reporting it as 501
 * "this node runs the FreeSWITCH stack, migrate it" sends an operator to fix a
 * migration that already happened, while the real answer is that a node is
 * unreachable. So a transport failure means "did not answer" (504) and is not
 * cached; only a heartbeat proves what a node is running.
 *
 * That relies on nodes announcing themselves. A regclient node does
 * (LLM_AGENT_URL); FreeSWITCH nodes do not yet, so until they do a legacy node
 * costs a connection attempt per request rather than a cached 501. The trade is
 * deliberate: a slower wrong-stack answer is better than a confident wrong one.
 *
 * The one failure still read as proof is a TLS handshake that completed enough
 * to reject the certificate — something is serving HTTPS there, and it is not
 * something our CA signed, so it is not a regclient node serving this API.
 */
export function capabilityFromFailure(err) {
  if (/certificate|self.signed|CERT_|DEPTH_ZERO|wrong version number|SSL routines/i.test(String(err?.message || ''))) {
    return CAPABILITY_NONE;
  }
  return CAPABILITY_UNKNOWN;
}

/**
 * The answer for a node that does not serve this API.
 *
 * 501 rather than 504: nothing is broken and nothing will improve by retrying.
 * The registration is simply held by a node running the stack that predates
 * these endpoints, and the fix is to migrate it — which is a decision, not an
 * incident.
 */
export function unsupportedNodeBody(node) {
  return {
    code: 'trace-api-unavailable',
    node,
    message: `The b2bua node holding this registration (${node}) does not provide the trace and probe API. ` +
      'It is running the FreeSWITCH stack, which has no such interface; migrate the registration to a regclient node to use it.'
  };
}
