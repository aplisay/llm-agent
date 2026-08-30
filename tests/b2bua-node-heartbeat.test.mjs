import { jest } from '@jest/globals';

/**
 * The b2bua node heartbeat: a node saying what it is, once a minute, so
 * llm-agent knows before the first trace request rather than finding out by
 * asking.
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
  B2BUA_NODE_TYPES: ['regclient', 'freeswitch'],
  PhoneRegistration: { findByPk: async () => null }
}));

const { default: route } = await import('../api/paths/agent-db/b2bua-nodes.js');
const { nodeCapability, resetNodeCapabilities, CAPABILITY_TRACE, CAPABILITY_NONE, CAPABILITY_UNKNOWN } =
  await import('../lib/regclient.js');
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

const beat = async (body, user) => {
  const res = makeRes();
  if (user !== undefined) res.locals.user = user;
  await post({ body, log: quietLog }, res);
  return res;
};

const list = async (query = {}) => {
  const res = makeRes();
  await get({ query, log: quietLog }, res);
  return res;
};

beforeEach(() => {
  rows.clear();
  resetNodeCapabilities();
});

describe('POST /agent-db/b2bua-nodes', () => {
  it('records what a node says about itself', async () => {
    const res = await beat({
      nodeId: '203.0.113.10',
      type: 'regclient',
      version: '1.4.2',
      registrations: 42,
      failedRegistrations: 3,
      systemLoad: 0.75
    });

    expect(res._status).toBe(200);
    expect(res._body.nodeId).toBe('203.0.113.10');
    expect(typeof res._body.acknowledgedAt).toBe('string');

    const stored = rows.get('203.0.113.10');
    expect(stored.type).toBe('regclient');
    expect(stored.version).toBe('1.4.2');
    expect(stored.registrations).toBe(42);
    expect(stored.failedRegistrations).toBe(3);
    expect(stored.systemLoad).toBe(0.75);
    expect(stored.lastSeenAt).toBeInstanceOf(Date);
  });

  // The point of the whole mechanism: known before anything is asked.
  it('primes the capability cache, so no discovery is needed at all', async () => {
    expect(nodeCapability('203.0.113.10')).toBe(CAPABILITY_UNKNOWN);
    await beat({ nodeId: '203.0.113.10', type: 'regclient' });
    expect(nodeCapability('203.0.113.10')).toBe(CAPABILITY_TRACE);
  });

  it('records a FreeSWITCH node as one that serves no trace API', async () => {
    await beat({ nodeId: '203.0.113.99', type: 'freeswitch' });
    expect(nodeCapability('203.0.113.99')).toBe(CAPABILITY_NONE);
  });

  // A caller who could post here could mark a node as the wrong stack, denying
  // traces that exist or aiming requests at a node that cannot answer.
  it('accepts heartbeats only from internal callers', async () => {
    const res = await beat({ nodeId: '203.0.113.10' }, { id: 'user-1', organisationId: 'org-1' });
    expect(res._status).toBe(403);
    expect(rows.size).toBe(0);
  });

  it('rejects a heartbeat with no node identity or an unknown stack', async () => {
    expect((await beat({}))._status).toBe(400);
    expect((await beat({ nodeId: '   ' }))._status).toBe(400);
    expect((await beat({ nodeId: '203.0.113.10', type: 'asterisk' }))._status).toBe(400);
    expect(rows.size).toBe(0);
  });

  // A node that cannot count its own registrations should not be able to zero
  // the fleet view by accident.
  it('defaults counters rather than storing rubbish', async () => {
    await beat({ nodeId: '203.0.113.10', registrations: 'lots', systemLoad: null });
    const stored = rows.get('203.0.113.10');
    expect(stored.registrations).toBe(0);
    expect(stored.failedRegistrations).toBe(0);
    expect(stored.systemLoad).toBeNull();
  });

  it('is an upsert — a node reports every minute for the life of the process', async () => {
    await beat({ nodeId: '203.0.113.10', registrations: 10 });
    await beat({ nodeId: '203.0.113.10', registrations: 11 });
    expect(rows.size).toBe(1);
    expect(rows.get('203.0.113.10').registrations).toBe(11);
  });
});

describe('GET /agent-db/b2bua-nodes', () => {
  it('reports the fleet, marking nodes that have gone quiet', async () => {
    await beat({ nodeId: '203.0.113.10', type: 'regclient', registrations: 5 });
    rows.set('203.0.113.99', {
      nodeId: '203.0.113.99',
      type: 'regclient',
      registrations: 0,
      failedRegistrations: 0,
      systemLoad: null,
      lastSeenAt: new Date(Date.now() - 20 * 60 * 1000)
    });

    const res = await list();
    expect(res._status).toBe(200);
    expect(res._body.nodes).toHaveLength(2);

    const live = res._body.nodes.find((n) => n.nodeId === '203.0.113.10');
    const quiet = res._body.nodes.find((n) => n.nodeId === '203.0.113.99');
    expect(live.stale).toBe(false);
    expect(live.registrations).toBe(5);
    // Reported, not omitted: a node that has gone quiet is the thing worth
    // seeing, and it is invisible if the row simply disappears.
    expect(quiet.stale).toBe(true);
  });
});

describe('capabilityFromHeartbeat', () => {
  it('answers from what the node last said', async () => {
    await beat({ nodeId: '203.0.113.10', type: 'regclient' });
    await beat({ nodeId: '203.0.113.99', type: 'freeswitch' });

    expect(await capabilityFromHeartbeat('203.0.113.10')).toBe(CAPABILITY_TRACE);
    expect(await capabilityFromHeartbeat('203.0.113.99')).toBe(CAPABILITY_NONE);
  });

  it('knows nothing about a node that has never reported', async () => {
    expect(await capabilityFromHeartbeat('203.0.113.50')).toBe(CAPABILITY_UNKNOWN);
  });

  // A regclient node whose heartbeat has broken is still a regclient node.
  // Reading a stale row as "no trace API" would refuse traces precisely when
  // somebody most wants to look at them.
  it('treats a stale row as telling us nothing, not as a denial', async () => {
    rows.set('203.0.113.10', {
      nodeId: '203.0.113.10',
      type: 'regclient',
      lastSeenAt: new Date(Date.now() - 10 * 60 * 1000)
    });
    expect(await capabilityFromHeartbeat('203.0.113.10')).toBe(CAPABILITY_UNKNOWN);

    rows.set('203.0.113.99', {
      nodeId: '203.0.113.99',
      type: 'freeswitch',
      lastSeenAt: new Date(Date.now() - 10 * 60 * 1000)
    });
    expect(await capabilityFromHeartbeat('203.0.113.99')).toBe(CAPABILITY_UNKNOWN);
  });

  // The registry is an optimisation, not a dependency.
  it('falls through to discovery when the registry cannot be read', async () => {
    const broken = { async findByPk() { throw new Error('database is down'); } };
    expect(await capabilityFromHeartbeat('203.0.113.10', { model: broken })).toBe(CAPABILITY_UNKNOWN);
  });
});
