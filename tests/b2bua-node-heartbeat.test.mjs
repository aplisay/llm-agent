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
const { capabilityFromHeartbeat, nodeDialAddress } = await import('../lib/regclient-facade.js');

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

const list = async (query = {}, user) => {
  const res = makeRes();
  if (user !== undefined) res.locals.user = user;
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

  // `/api/agent-db` is already refused at the prefix for anything without the
  // shared token, so this is defence in depth — but the POST checks explicitly
  // and a GET that did not read as though the difference were deliberate. It
  // is not: this listing is every node's public IP, stack, version,
  // registration counts and load.
  it('is refused to a caller who is not the internal system user', async () => {
    await beat({ nodeId: '203.0.113.10', type: 'regclient' });
    const res = await list({}, { id: 'u1', organisationId: 'org-1' });
    expect(res._status).toBe(403);
    expect(res._body.nodes).toBeUndefined();
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

describe('the scoped node principal', () => {
  // A node runs internet-facing SIP and needs exactly one route. The
  // fleet-wide SHARED_API_TOKEN is accepted on every internal route and mints
  // a full system principal, so a node carrying it turns one compromised SIP
  // machine into complete internal-API access. B2BUA_HEARTBEAT_TOKEN mints
  // this principal instead: it may announce, and nothing else.
  const nodePrincipal = () => ({
    locals: { user: { id: 'b2bua-node', isB2buaNode: true } },
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    send(body) { this._body = body; this._status = this._status || 200; return this; },
    json(body) { return this.send(body); }
  });

  it('may announce itself', async () => {
    const res = nodePrincipal();
    await post({ body: { nodeId: '203.0.113.77', type: 'regclient' }, log: quietLog }, res);
    expect(res._status).toBe(200);
    expect(res._body.nodeId).toBe('203.0.113.77');
  });

  // The listing is every node's public IP, stack, version, registration counts
  // and load — a map of the estate. A node has no business reading it.
  it('may not read the fleet listing back', async () => {
    const res = nodePrincipal();
    await get({ query: {}, log: quietLog }, res);
    expect(res._status).toBe(403);
  });

  // Anything without one of the two internal principals is refused, which is
  // what stops a tenant reaching this route and mislabelling a node's stack.
  it('refuses an ordinary caller', async () => {
    const res = nodePrincipal();
    res.locals.user = { id: 'someone', organisationId: 'org-1' };
    await post({ body: { nodeId: '203.0.113.77', type: 'freeswitch' }, log: quietLog }, res);
    expect(res._status).toBe(403);
  });
});

describe('the private address a node reports', () => {
  // A node reports where it answers from inside its own network, and llm-agent
  // uses that when the two share a VPC: the request never leaves it, so the
  // node API needs no public exposure and no firewall rule keyed to an egress
  // address Cloud Run does not have.
  //
  // It lives here and not in phone_registrations.b2bua_id because that column
  // is also read as a SIP gateway address by the LiveKit agent and the pipecat
  // poller, where a compound value would break outbound call routing.
  const PUBLIC = '203.0.113.10';
  const PRIVATE = '10.154.0.62';

  const internal = () => ({
    locals: { user: { id: 'system', isSystem: true } },
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    send(body) { this._body = body; this._status = this._status || 200; return this; },
    json(body) { return this.send(body); }
  });

  const announce = async (body) => {
    const res = internal();
    await post({ body, log: quietLog }, res);
    return res;
  };

  beforeEach(() => { rows.clear(); });

  it('is stored when the node reports one', async () => {
    expect((await announce({ nodeId: PUBLIC, privateAddress: PRIVATE }))._status).toBe(200);
    expect(rows.get(PUBLIC).privateAddress).toBe(PRIVATE);
  });

  // A node that has no distinct private address, or predates the field, must
  // leave the column null rather than empty — so "never told us" and "told us
  // nothing" read the same downstream.
  it('is null when the node reports none', async () => {
    await announce({ nodeId: PUBLIC });
    expect(rows.get(PUBLIC).privateAddress).toBeNull();
    await announce({ nodeId: PUBLIC, privateAddress: '   ' });
    expect(rows.get(PUBLIC).privateAddress).toBeNull();
  });

  it('is only dialled when the deployment opts in', async () => {
    await announce({ nodeId: PUBLIC, privateAddress: PRIVATE });
    const config = { scheme: 'https', port: 8443 };

    expect(await nodeDialAddress(PUBLIC, config, { env: {}, model: B2buaNode }))
      .toBe(PUBLIC);
    expect(await nodeDialAddress(PUBLIC, config, { env: { REGCLIENT_USE_PRIVATE_NODE_ADDRESS: '1' }, model: B2buaNode }))
      .toBe(PRIVATE);
  });

  // The heartbeat token is shared across nodes, so a node reporting the
  // metadata server's address must not be believed. assertNodeAddressAllowed
  // refuses link-local whatever else is permitted, and that is the property
  // this asserts.
  it('never dials link-local, opted in or not', async () => {
    await announce({ nodeId: PUBLIC, privateAddress: '169.254.169.254' });
    const got = await nodeDialAddress(PUBLIC, { scheme: 'https', port: 8443 }, {
      env: { REGCLIENT_USE_PRIVATE_NODE_ADDRESS: '1' },
      model: B2buaNode,
      log: quietLog
    });
    expect(got).toBe(PUBLIC);
  });

  // A node that has never heartbeated, or a registry read that fails, must fall
  // back to the public address rather than failing the request.
  it('falls back to the public address when nothing is known', async () => {
    const env = { REGCLIENT_USE_PRIVATE_NODE_ADDRESS: '1' };
    const config = { scheme: 'https', port: 8443 };
    expect(await nodeDialAddress('198.51.100.7', config, { env, model: B2buaNode })).toBe('198.51.100.7');

    const broken = { async findByPk() { throw new Error('database is down'); } };
    expect(await nodeDialAddress(PUBLIC, config, { env, model: broken })).toBe(PUBLIC);
  });
});
