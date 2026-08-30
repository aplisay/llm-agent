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

const boolEnv = (value, dflt = false) => {
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

/** URL of one trace representation on a node. */
export function buildTraceUrl({ node, registrationId, format = 'json', since }, config) {
  const { scheme, port } = config;
  const host = net.isIP(node) === 6 ? `[${node}]` : node;
  const url = new URL(`${scheme}://${host}:${port}/debug/registrations/${encodeURIComponent(registrationId)}/trace`);
  if (format && format !== 'json') url.searchParams.set('format', format);
  if (since) url.searchParams.set('since', String(since));
  return url.toString();
}

/** URL of the probe collection, or of one probe / its event stream. */
export function buildProbeUrl({ node, probeId, events = false }, config) {
  const { scheme, port } = config;
  const host = net.isIP(node) === 6 ? `[${node}]` : node;
  const path = probeId
    ? `/probe/${encodeURIComponent(probeId)}${events ? '/events' : ''}`
    : '/probe';
  return new URL(`${scheme}://${host}:${port}${path}`).toString();
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
  requestImpl = axios.request,
  signal
}) {
  const agent = createNodeAgent(config);
  const request = {
    url,
    method,
    responseType,
    timeout: config.timeoutMs,
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
  return requestImpl(request);
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
 * Which node should answer a probe for this registration?
 *
 * A claimed row must be probed by its owner — that node holds the live
 * registration and can therefore reuse its canonical Contact instead of
 * creating a second binding at the PBX. An unclaimed row has no owner, so any
 * node in `REGCLIENT_PROBE_NODES` will do; the choice is made deterministically
 * from the registration id so repeated calls about one row land on one node and
 * its probe ids stay resolvable.
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
