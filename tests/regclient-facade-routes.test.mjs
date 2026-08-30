import { jest } from '@jest/globals';

/**
 * The b2bua node-API facade routes: `GET /phone-endpoints/{id}/trace` and the
 * probe family.
 *
 * These routes hold no state of their own — everything interesting is in what
 * they refuse to do (someone else's registration, an address we won't send a
 * token to, a deployment with no CA configured) and in how a node that isn't
 * answering is reported. So that is what is tested here, with the database and
 * the HTTP client both stubbed.
 */

const rows = new Map();

// The heartbeat registry is deliberately empty here: these tests exercise the
// discovery path, which is what a node that has never announced itself falls
// back to.
jest.unstable_mockModule('../lib/database.js', () => ({
  PhoneRegistration: {
    findByPk: async (id) => rows.get(id) || null
  },
  B2buaNode: {
    findByPk: async () => null
  },
  B2BUA_NODE_TYPES: ['regclient', 'freeswitch']
}));

let nextResponse = { status: 200, data: {} };
let lastRequest = null;

jest.unstable_mockModule('axios', () => ({
  default: {
    request: async (request) => {
      lastRequest = request;
      if (nextResponse instanceof Error) throw nextResponse;
      return nextResponse;
    }
  }
}));

const { resetNodeCapabilities, nodeCapability, CAPABILITY_NONE } = await import('../lib/regclient.js');
const { verifyProbeHandle, signProbeHandle } = await import('../lib/regclient-probe-handle.js');

const { default: traceRoute } = await import('../api/paths/phone-endpoints/{identifier}/trace.js');
const { default: traceTransactionRoute } = await import('../api/paths/phone-endpoints/{identifier}/trace/{transactionId}.js');
const { default: probeRoute } = await import('../api/paths/phone-endpoints/{identifier}/probe.js');
const { default: probeReportRoute } = await import('../api/paths/phone-endpoints/{identifier}/probe/{probeId}.js');

const quietLog = { info() {}, error() {}, warn() {}, debug() {} };
const getTrace = traceRoute(quietLog).GET;
const getTraceTransaction = traceTransactionRoute(quietLog).GET;
const startProbe = probeRoute(quietLog).POST;
const getProbeReport = probeReportRoute(quietLog).GET;

const ORG = 'org-1';
const REG = '11111111-2222-3333-4444-555555555555';

const configuredEnv = {
  REGCLIENT_API_TOKEN: 'node-token',
  REGCLIENT_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
};

// A principal that holds the endpoint permissions these routes now require.
// The routes gate on phoneEndpoint:read / :update as the endpoint routes
// themselves do — organisation ownership alone was a weaker gate than the
// record the trace describes.
const OPERATOR = {
  organisationId: ORG,
  _effectivePermissions: { phoneEndpoint: ['claim', 'read', 'update', 'release'] }
};

// Read-only: may see the endpoint, may not change it. A probe changes it.
const READER = {
  organisationId: ORG,
  _effectivePermissions: { phoneEndpoint: ['read'] }
};

const makeRes = (user = OPERATOR) => ({
  locals: { user: { ...user } },
  _status: null,
  _body: null,
  _headers: {},
  status(code) { this._status = code; return this; },
  send(body) { this._body = body; this._status = this._status || 200; return this; },
  json(body) { return this.send(body); },
  setHeader(name, value) { this._headers[name] = value; }
});

const makeReg = ({ id = REG, organisationId = ORG, b2buaId = '203.0.113.10' } = {}) => {
  const row = { id, organisationId, b2buaId };
  rows.set(id, row);
  return row;
};

const callTrace = async ({ identifier = REG, query = {}, user } = {}) => {
  const res = makeRes();
  if (user !== undefined) res.locals.user = user;
  await getTrace({ params: { identifier }, query, log: quietLog }, res);
  return res;
};

const callTraceTransaction = async ({ identifier = REG, transactionId = 'reg-8', query = {}, user } = {}) => {
  const res = makeRes();
  if (user !== undefined) res.locals.user = user;
  await getTraceTransaction({ params: { identifier, transactionId }, query, log: quietLog }, res);
  return res;
};

const callProbeReport = async ({ identifier = REG, probeId, user } = {}) => {
  const res = makeRes();
  if (user !== undefined) res.locals.user = user;
  await getProbeReport({ params: { identifier, probeId }, log: quietLog }, res);
  return res;
};

const callProbe = async ({ identifier = REG, body = {}, user } = {}) => {
  const res = makeRes();
  if (user !== undefined) res.locals.user = user;
  await startProbe({ params: { identifier }, body, log: quietLog }, res);
  return res;
};

beforeEach(() => {
  rows.clear();
  lastRequest = null;
  resetNodeCapabilities();
  nextResponse = { status: 200, data: {} };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('REGCLIENT_') || key === 'TRACE_PROXY_TIMEOUT_MS') delete process.env[key];
  }
  Object.assign(process.env, configuredEnv);
});

describe('GET /phone-endpoints/{identifier}/trace', () => {
  it('rejects a phone number — traces belong to registrations', async () => {
    const res = await callTrace({ identifier: '441234567890' });
    expect(res._status).toBe(400);
  });

  it('rejects an unknown format rather than passing it to the node', async () => {
    makeReg();
    const res = await callTrace({ query: { format: 'sqlite' } });
    expect(res._status).toBe(400);
    expect(lastRequest).toBeNull();
  });

  // decode on the index would be the fat response the split exists to avoid,
  // so it is refused here with a pointer at the route that does serve it.
  it('sends decode to the per-transaction route rather than serving it', async () => {
    makeReg();
    const res = await callTrace({ query: { format: 'decode' } });
    expect(res._status).toBe(400);
    expect(res._body.message).toMatch(/transactionId/);
    expect(lastRequest).toBeNull();
  });

  it('404s an unknown registration', async () => {
    expect((await callTrace())._status).toBe(404);
  });

  it('403s a registration belonging to another organisation', async () => {
    makeReg({ organisationId: 'org-2' });
    const res = await callTrace();
    expect(res._status).toBe(403);
    expect(lastRequest).toBeNull();
  });

  // Both sides of an organisation comparison can legitimately be null: an
  // org-less principal, and a row left org-less by the `SET NULL` on
  // organisation delete. A bare `registration.organisationId !== organisationId`
  // reads `null !== null` as false and so *granted* access — letting two
  // unrelated org-less tenants read each other's registrar, account identity
  // and credentials in flight. scope.js's userOwnsRow requires both sides to be
  // non-null and equal, which is why the routes must go through it.
  it('403s an org-less caller against an org-less registration', async () => {
    makeReg({ organisationId: null });
    const res = await callTrace({
      user: { organisationId: null, _effectivePermissions: { phoneEndpoint: ['read'] } }
    });
    expect(res._status).toBe(403);
    expect(lastRequest).toBeNull();
  });

  it('409s a registration no node has ever claimed', async () => {
    makeReg({ b2buaId: null });
    const res = await callTrace();
    expect(res._status).toBe(409);
    expect(lastRequest).toBeNull();
  });

  it('503s when this deployment has no node credentials configured', async () => {
    delete process.env.REGCLIENT_API_TOKEN;
    makeReg();
    const res = await callTrace();
    expect(res._status).toBe(503);
    expect(res._body.message).toMatch(/REGCLIENT_API_TOKEN/);
  });

  it('refuses to dial a node address that is not routable for this deployment', async () => {
    // `b2buaId` is writable through the public update API, so a hostile value
    // must not become an SSRF request carrying the node bearer token.
    makeReg({ b2buaId: '169.254.169.254' });
    const res = await callTrace();
    expect(res._status).toBe(502);
    expect(lastRequest).toBeNull();
  });

  it('proxies the index, adding provenance', async () => {
    makeReg();
    nextResponse = {
      status: 200,
      data: { registrationId: REG, transactions: [{ id: 'reg-8', kind: 'register' }] }
    };
    const res = await callTrace();
    expect(res._status).toBe(200);
    expect(res._body.node).toBe('203.0.113.10');
    expect(typeof res._body.fetchedAt).toBe('string');
    expect(res._body.transactions).toHaveLength(1);
    expect(lastRequest.url).toBe(`https://203.0.113.10:8443/debug/registrations/${REG}/trace`);
    expect(lastRequest.headers.Authorization).toBe('Bearer node-token');
  });

  it('returns pcap as a whole-registration binary attachment', async () => {
    makeReg();
    nextResponse = { status: 200, data: Buffer.from([0xd4, 0xc3, 0xb2, 0xa1]) };
    const res = await callTrace({ query: { format: 'pcap' } });
    expect(res._headers['Content-Type']).toBe('application/vnd.tcpdump.pcap');
    expect(res._headers['Content-Disposition']).toContain(`${REG}.pcap`);
    expect(Buffer.isBuffer(res._body)).toBe(true);
    expect(lastRequest.responseType).toBe('arraybuffer');
  });

  // During the migration both stacks run against the same table, so a
  // registration held by a FreeSWITCH node is an ordinary state of affairs.
  // Reporting it as an outage would send somebody looking for a fault.
  it('says plainly when the node has no trace API at all', async () => {
    makeReg();
    nextResponse = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const res = await callTrace();

    expect(res._status).toBe(501);
    expect(res._body.code).toBe('trace-api-unavailable');
    expect(res._body.node).toBe('203.0.113.10');
    expect(res._body.message).toMatch(/FreeSWITCH/);
  });

  // And having learned it once, it costs nothing thereafter — which is the
  // whole point: no timeout, and not even a connection.
  it('answers a known FreeSWITCH node without touching the network', async () => {
    makeReg();
    nextResponse = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    await callTrace();
    expect(nodeCapability('203.0.113.10')).toBe(CAPABILITY_NONE);

    lastRequest = null;
    const res = await callTrace();
    expect(res._status).toBe(501);
    expect(lastRequest).toBeNull();
  });

  // A slow node is a different thing from an absent one, and must not be
  // remembered as one.
  it('still reports a timeout as a timeout', async () => {
    makeReg();
    nextResponse = Object.assign(new Error('timeout of 750ms exceeded'), { code: 'ECONNABORTED' });
    const res = await callTrace();

    expect(res._status).toBe(504);
    expect(res._body.reason).toBe('timeout');

    // Nothing was concluded, so the next call tries again.
    lastRequest = null;
    nextResponse = { status: 200, data: { registrationId: REG } };
    expect((await callTrace())._status).toBe(200);
    expect(lastRequest).not.toBeNull();
  });

  it('turns an unreachable node into a 504 that names the node', async () => {
    makeReg();
    nextResponse = Object.assign(new Error('timeout of 2000ms exceeded'), { code: 'ECONNABORTED' });
    const res = await callTrace();
    expect(res._status).toBe(504);
    expect(res._body).toEqual({ error: 'trace unavailable', node: '203.0.113.10', reason: 'timeout' });
  });

  it('reports a node error as 502, and a node 404 as 404', async () => {
    makeReg();
    nextResponse = { status: 500, data: {} };
    expect((await callTrace())._status).toBe(502);
    nextResponse = { status: 404, data: {} };
    expect((await callTrace())._status).toBe(404);
  });
});

describe('GET /phone-endpoints/{identifier}/trace/{transactionId}', () => {
  it('fetches one exchange in full', async () => {
    makeReg();
    nextResponse = {
      status: 200,
      data: { registrationId: REG, registerTransactions: [{ id: 'reg-8', messages: [{}, {}] }] }
    };
    const res = await callTraceTransaction();
    expect(res._status).toBe(200);
    expect(res._body.node).toBe('203.0.113.10');
    expect(lastRequest.url).toBe(`https://203.0.113.10:8443/debug/registrations/${REG}/trace/reg-8`);
  });

  it('offers the decoded packets of that exchange', async () => {
    makeReg();
    nextResponse = { status: 200, data: [{ ts: '2026-08-30T10:00:00Z' }] };
    const res = await callTraceTransaction({ query: { format: 'decode' } });
    expect(Array.isArray(res._body)).toBe(true);
    expect(res._headers['X-Regclient-Node']).toBe('203.0.113.10');
    expect(new URL(lastRequest.url).searchParams.get('format')).toBe('decode');
  });

  it('names the exchange in the capture filename', async () => {
    makeReg();
    nextResponse = { status: 200, data: Buffer.from([0xd4, 0xc3, 0xb2, 0xa1]) };
    const res = await callTraceTransaction({ query: { format: 'pcap' } });
    expect(res._headers['Content-Disposition']).toContain(`${REG}-reg-8.pcap`);
  });

  // Trace entries rotate. An id listed a few minutes ago may have aged out
  // behind a burst of retries, and saying so beats implying the registration
  // itself is unknown.
  it('explains a transaction that has rotated out', async () => {
    makeReg();
    nextResponse = { status: 404, data: {} };
    const res = await callTraceTransaction();
    expect(res._status).toBe(404);
    expect(res._body.message).toMatch(/rotated out/);
  });

  it('applies the same organisation and node checks as the index', async () => {
    makeReg({ organisationId: 'org-2' });
    expect((await callTraceTransaction())._status).toBe(403);
    expect(lastRequest).toBeNull();

    rows.clear();
    makeReg({ b2buaId: null });
    expect((await callTraceTransaction())._status).toBe(409);
    expect(lastRequest).toBeNull();
  });
});

describe('POST /phone-endpoints/{identifier}/probe', () => {
  it('starts a probe on the claiming node and returns the probe id', async () => {
    makeReg();
    nextResponse = { status: 200, data: { probeId: 'p-1' } };
    const res = await callProbe({ body: { discover: true } });
    expect(res._status).toBe(202);
    expect(res._body.node).toBe('203.0.113.10');
    // The id handed back is a signed handle, not the node's own probe id: it
    // names the node this probe is running on and the registration it is for,
    // so a follow-up cannot be misrouted by a migration or pointed at somebody
    // else's probe. See lib/regclient-probe-handle.js.
    expect(res._body.probeId).not.toBe('p-1');
    expect(verifyProbeHandle(res._body.probeId, { registrationId: REG }, { token: 'node-token' }))
      .toMatchObject({ ok: true, node: '203.0.113.10', probeId: 'p-1' });
    expect(lastRequest.url).toBe('https://203.0.113.10:8443/probe');
    expect(lastRequest.method).toBe('POST');
    expect(lastRequest.data).toEqual({ registrationId: REG, discover: true, apply: false });
  });

  it('uses the probe node pool when no node has claimed the registration', async () => {
    process.env.REGCLIENT_PROBE_NODES = '198.51.100.7';
    makeReg({ b2buaId: null });
    nextResponse = { status: 200, data: { probeId: 'p-2' } };
    const res = await callProbe();
    expect(res._status).toBe(202);
    expect(lastRequest.url).toBe('https://198.51.100.7:8443/probe');
  });

  it('says plainly when the node has no probe API either', async () => {
    makeReg();
    nextResponse = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const res = await callProbe();
    expect(res._status).toBe(501);
    expect(res._body.code).toBe('trace-api-unavailable');
  });

  it('409s an unclaimed registration when there is no pool to run it on', async () => {
    makeReg({ b2buaId: null });
    const res = await callProbe();
    expect(res._status).toBe(409);
    expect(lastRequest).toBeNull();
  });

  it('never probes another organisation\'s registration', async () => {
    makeReg({ organisationId: 'org-2' });
    expect((await callProbe())._status).toBe(403);
    expect(lastRequest).toBeNull();
  });
});

// ── RBAC ────────────────────────────────────────────────────────────────────

// Organisation ownership was the only gate these routes applied, while the
// endpoint routes they hang off require phoneEndpoint:read. That made the SIP
// trace — the endpoint's registrar, its account identity, who has been calling
// it — readable by a member who cannot read the endpoint record itself.
describe('permissions', () => {
  const NO_RIGHTS = { organisationId: ORG, _effectivePermissions: {} };

  it('requires phoneEndpoint:read for the trace index and one exchange', async () => {
    makeReg();
    for (const call of [callTrace, callTraceTransaction]) {
      const res = await call({ user: NO_RIGHTS });
      expect(res._status).toBe(403);
      expect(lastRequest).toBeNull();
    }
  });

  // A probe is a write: it puts a real REGISTER on the wire from an address the
  // customer's PBX trusts, and with `apply` it edits the registration.
  it('requires phoneEndpoint:update to start a probe, not merely :read', async () => {
    makeReg();
    const res = await callProbe({ user: READER });
    expect(res._status).toBe(403);
    expect(lastRequest).toBeNull();
  });

  it('lets a reader read a probe report they may not have started', async () => {
    makeReg();
    nextResponse = { status: 200, data: { probeId: 'p-1', verdict: 'registered' } };
    const handle = signProbeHandle(
      { node: '203.0.113.10', registrationId: REG, probeId: 'p-1' },
      { token: 'node-token' }
    );
    const res = await callProbeReport({ probeId: handle, user: READER });
    expect(res._status).toBe(200);
  });
});

// ── probe handles ───────────────────────────────────────────────────────────

describe('probe handles', () => {
  it('asks the node the handle names, not whichever node holds the row now', async () => {
    // The registration has since migrated. The probe is still running where it
    // started, and that is where the follow-up has to go — an operator watching
    // a probe is exactly the person likely to be moving the row.
    makeReg({ b2buaId: '203.0.113.99' });
    nextResponse = { status: 200, data: { probeId: 'p-1', verdict: 'registered' } };

    const handle = signProbeHandle(
      { node: '203.0.113.10', registrationId: REG, probeId: 'p-1' },
      { token: 'node-token' }
    );
    const res = await callProbeReport({ probeId: handle });
    expect(res._status).toBe(200);
    expect(lastRequest.url).toContain('203.0.113.10');
    expect(lastRequest.url).not.toContain('203.0.113.99');
    // And the node is told which registration to check the probe against, so
    // the binding is enforced by the process that actually knows the answer.
    expect(lastRequest.url).toContain(`registrationId=${REG}`);
  });

  it('refuses a probe handle issued for a different registration', async () => {
    makeReg();
    const other = signProbeHandle(
      { node: '203.0.113.10', registrationId: 'someone-elses-registration', probeId: 'p-1' },
      { token: 'node-token' }
    );
    const res = await callProbeReport({ probeId: other });
    // 404, not 403: whether a probe exists on a node is itself a fact about
    // another registration.
    expect(res._status).toBe(404);
    expect(lastRequest).toBeNull();
  });

  it('refuses a forged or bare probe id', async () => {
    makeReg();
    for (const probeId of ['p-1', 'v1.abc.def', '']) {
      const res = await callProbeReport({ probeId });
      expect(res._status).toBe(404);
      expect(lastRequest).toBeNull();
    }
  });

  it('refuses a handle signed with a different node token', async () => {
    makeReg();
    const forged = signProbeHandle(
      { node: '203.0.113.10', registrationId: REG, probeId: 'p-1' },
      { token: 'not-our-token' }
    );
    const res = await callProbeReport({ probeId: forged });
    expect(res._status).toBe(404);
    expect(lastRequest).toBeNull();
  });
});
