import { jest } from '@jest/globals';

/**
 * A regserver node announcing itself. It is the registrar customers' PBXes
 * register to (aplisay-strategy regserver-tactical-spec.md): it serves the
 * trace API like regclient, reports how many PBXes are bound to it, and is
 * never chosen to run a probe.
 */

const rows = new Map();

const B2buaNode = {
  async upsert(values) {
    rows.set(values.nodeId, { ...values });
    return [rows.get(values.nodeId), true];
  },
  async findByPk(id) {
    return rows.get(id) || null;
  },
  async findAll() {
    return [...rows.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }
};

jest.unstable_mockModule('../lib/database.js', () => ({
  B2buaNode,
  B2BUA_NODE_TYPES: ['regclient', 'regserver', 'freeswitch'],
  PhoneRegistration: { findByPk: async () => null }
}));

const { default: route } = await import('../api/paths/agent-db/b2bua-nodes.js');
const {
  nodeCapability, resetNodeCapabilities, nodeServesTraceApi, pickLeastLoadedNode, buildBindingsUrl,
  CAPABILITY_TRACE, CAPABILITY_NONE
} = await import('../lib/regclient.js');
const { capabilityFromHeartbeat } = await import('../lib/regclient-facade.js');

const quietLog = { info() {}, error() {}, warn() {}, debug() {} };
const post = route(quietLog).POST;
const get = route(quietLog).GET;

const makeRes = () => ({
  locals: { user: { id: 'system', isSystem: true } },
  _status: null,
  _body: null,
  status(code) { this._status = code; return this; },
  send(body) { this._body = body; this._status = this._status || 200; return this; },
  json(body) { return this.send(body); }
});

const beat = async (body) => {
  const res = makeRes();
  await post({ body, log: quietLog }, res);
  return res;
};

beforeEach(() => {
  rows.clear();
  resetNodeCapabilities();
});

describe('a regserver heartbeat', () => {
  it('is accepted, with its bindings count, and identified by its DNS name', async () => {
    const res = await beat({
      nodeId: 'lon1-1.sip.polite.ai',
      privateAddress: '10.106.0.4',
      type: 'regserver',
      version: 'beta-0.3.0',
      registrations: 11,
      failedRegistrations: 1,
      bindings: 12,
      systemLoad: 0.2
    });
    expect(res._status).toBe(200);
    const row = rows.get('lon1-1.sip.polite.ai');
    expect(row.type).toBe('regserver');
    expect(row.bindings).toBe(12);
    expect(row.privateAddress).toBe('10.106.0.4');
  });

  it('primes the capability cache: a regserver node serves traces', async () => {
    await beat({ nodeId: 'lon1-1.sip.polite.ai', type: 'regserver' });
    expect(nodeCapability('lon1-1.sip.polite.ai')).toBe(CAPABILITY_TRACE);
    resetNodeCapabilities();
    expect(await capabilityFromHeartbeat('lon1-1.sip.polite.ai')).toBe(CAPABILITY_TRACE);
  });

  it('leaves the other stacks as they were', async () => {
    await beat({ nodeId: '203.0.113.10', type: 'regclient', registrations: 3 });
    await beat({ nodeId: '203.0.113.11', type: 'freeswitch' });
    expect(rows.get('203.0.113.10').bindings).toBe(0);
    expect(nodeCapability('203.0.113.10')).toBe(CAPABILITY_TRACE);
    expect(nodeCapability('203.0.113.11')).toBe(CAPABILITY_NONE);
    expect(nodeServesTraceApi('regclient')).toBe(true);
    expect(nodeServesTraceApi('regserver')).toBe(true);
    expect(nodeServesTraceApi('freeswitch')).toBe(false);
  });

  it('shows bindings in the fleet listing', async () => {
    await beat({ nodeId: 'lon1-1.sip.polite.ai', type: 'regserver', bindings: 5 });
    await beat({ nodeId: '203.0.113.10', type: 'regclient' });
    const res = makeRes();
    await get({ query: {}, log: quietLog }, res);
    expect(res._status).toBe(200);
    const byId = Object.fromEntries(res._body.nodes.map((n) => [n.nodeId, n]));
    expect(byId['lon1-1.sip.polite.ai'].bindings).toBe(5);
    expect(byId['203.0.113.10'].bindings).toBe(0);
  });

  it('is never chosen to probe an unclaimed line', () => {
    const now = Date.now();
    const chosen = pickLeastLoadedNode([
      { nodeId: 'lon1-1.sip.polite.ai', type: 'regserver', systemLoad: 0.01, registrations: 0, lastSeenAt: new Date(now) },
      { nodeId: '203.0.113.10', type: 'regclient', systemLoad: 2.5, registrations: 40, lastSeenAt: new Date(now) }
    ], { now });
    expect(chosen).toBe('203.0.113.10');
  });
});

describe('buildBindingsUrl', () => {
  it('addresses the node API bindings route, bracketing IPv6', () => {
    const config = { scheme: 'https', port: 8443 };
    expect(buildBindingsUrl({ node: 'lon1-1.sip.polite.ai', registrationId: 'abc' }, config))
      .toBe('https://lon1-1.sip.polite.ai:8443/debug/registrations/abc/bindings');
    expect(buildBindingsUrl({ node: '2001:db8::1', registrationId: 'abc' }, config))
      .toBe('https://[2001:db8::1]:8443/debug/registrations/abc/bindings');
  });
});
