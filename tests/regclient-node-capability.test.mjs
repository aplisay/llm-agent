import {
  loadRegclientConfig,
  nodeCapability,
  rememberNodeCapability,
  resetNodeCapabilities,
  capabilityFromFailure,
  unsupportedNodeBody,
  timeoutFor,
  nodeRequest,
  CAPABILITY_TRACE,
  CAPABILITY_NONE,
  CAPABILITY_UNKNOWN
} from '../lib/regclient.js';

// Knowing whether a b2bua node serves the trace API at all.
//
// During the migration both stacks run against the same table, so `b2bua_id`
// may point at a FreeSWITCH node with no HTTP surface whatsoever. Discovering
// that must cost a fraction of a second once, not the full request timeout on
// every call — and it must be reported as what it is rather than as an outage.

const config = loadRegclientConfig({
  REGCLIENT_API_TOKEN: 'token',
  REGCLIENT_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
});

beforeEach(() => resetNodeCapabilities());

describe('capability from a failed round-trip', () => {
  // These all say the same thing: whatever is at that address, it is not a
  // regclient node. They are also all fast by nature.
  it('reads a connection-level failure as "no trace API here"', () => {
    for (const code of ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPROTO']) {
      expect(capabilityFromFailure({ code })).toBe(CAPABILITY_NONE);
    }
    expect(capabilityFromFailure({ message: 'wrong version number' })).toBe(CAPABILITY_NONE);
    expect(capabilityFromFailure({ message: 'unable to verify the first certificate' })).toBe(CAPABILITY_NONE);
  });

  // A timeout says nothing of the kind: something may well be listening and
  // merely busy. Caching it would be a lie that outlived the moment.
  it('draws no conclusion from a timeout', () => {
    expect(capabilityFromFailure({ code: 'ECONNABORTED' })).toBe(CAPABILITY_UNKNOWN);
    expect(capabilityFromFailure({ code: 'ETIMEDOUT' })).toBe(CAPABILITY_UNKNOWN);
    expect(capabilityFromFailure({ message: 'socket hang up' })).toBe(CAPABILITY_UNKNOWN);
  });
});

describe('the cache', () => {
  it('starts knowing nothing', () => {
    expect(nodeCapability('203.0.113.10')).toBe(CAPABILITY_UNKNOWN);
  });

  it('holds a positive verdict long and a negative one briefly', () => {
    const env = { REGCLIENT_CAPABILITY_TTL_MS: '600000', REGCLIENT_UNSUPPORTED_TTL_MS: '60000' };
    let clock = 1_000_000;
    const now = () => clock;

    rememberNodeCapability('203.0.113.10', CAPABILITY_TRACE, { now });
    rememberNodeCapability('203.0.113.99', CAPABILITY_NONE, { now });

    clock += 90_000; // a minute and a half later
    expect(nodeCapability('203.0.113.10', { env, now })).toBe(CAPABILITY_TRACE);
    // A node migrated to regclient is exactly when somebody goes looking for
    // its traces, so a negative verdict must not outstay its welcome.
    expect(nodeCapability('203.0.113.99', { env, now })).toBe(CAPABILITY_UNKNOWN);

    clock += 600_000;
    expect(nodeCapability('203.0.113.10', { env, now })).toBe(CAPABILITY_UNKNOWN);
  });

  it('never records an inconclusive result', () => {
    rememberNodeCapability('203.0.113.10', CAPABILITY_UNKNOWN);
    expect(nodeCapability('203.0.113.10')).toBe(CAPABILITY_UNKNOWN);
  });
});

describe('timeoutFor', () => {
  // The point of the whole exercise: never spend the request budget finding out
  // that a node has no HTTP surface.
  it('bounds a node we have never reached much more tightly', () => {
    const env = { REGCLIENT_DISCOVERY_TIMEOUT_MS: '750' };
    expect(timeoutFor('203.0.113.10', config, { env })).toBe(750);

    rememberNodeCapability('203.0.113.10', CAPABILITY_TRACE);
    expect(timeoutFor('203.0.113.10', config, { env })).toBe(config.timeoutMs);
  });

  it('never lengthens the request budget', () => {
    const tight = loadRegclientConfig({ ...config, TRACE_PROXY_TIMEOUT_MS: '300', REGCLIENT_API_TOKEN: 't' });
    expect(timeoutFor('203.0.113.10', tight, { env: { REGCLIENT_DISCOVERY_TIMEOUT_MS: '750' } })).toBe(300);
  });
});

describe('nodeRequest learns as it goes', () => {
  // Reaching a node at all is the proof. A FreeSWITCH node has no HTTP surface,
  // and nothing else can present a certificate our own private CA signed — so
  // the request already is the capability probe, and needs no separate one.
  it('treats any answer as proof, whatever the status', async () => {
    await nodeRequest({
      url: 'https://203.0.113.10:8443/health',
      config,
      node: '203.0.113.10',
      requestImpl: async () => ({ status: 401, data: {} })
    });
    expect(nodeCapability('203.0.113.10')).toBe(CAPABILITY_TRACE);
  });

  it('records a refused connection so the next call costs nothing', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    await expect(nodeRequest({
      url: 'https://203.0.113.99:8443/health',
      config,
      node: '203.0.113.99',
      requestImpl: async () => { throw refused; }
    })).rejects.toThrow();
    expect(nodeCapability('203.0.113.99')).toBe(CAPABILITY_NONE);
  });

  it('does not condemn a node that merely timed out', async () => {
    const timedOut = Object.assign(new Error('timeout of 750ms exceeded'), { code: 'ECONNABORTED' });
    await expect(nodeRequest({
      url: 'https://203.0.113.10:8443/health',
      config,
      node: '203.0.113.10',
      requestImpl: async () => { throw timedOut; }
    })).rejects.toThrow();
    expect(nodeCapability('203.0.113.10')).toBe(CAPABILITY_UNKNOWN);
  });

  it('applies the discovery bound to a first request and the full budget after', async () => {
    let seen;
    const capture = async (request) => { seen = request; return { status: 200, data: {} }; };

    await nodeRequest({ url: 'https://203.0.113.10:8443/x', config, node: '203.0.113.10', requestImpl: capture });
    expect(seen.timeout).toBe(750); // discovery default

    await nodeRequest({ url: 'https://203.0.113.10:8443/x', config, node: '203.0.113.10', requestImpl: capture });
    expect(seen.timeout).toBe(config.timeoutMs);
  });
});

describe('what the caller is told', () => {
  it('names the node and says what to do about it', () => {
    const body = unsupportedNodeBody('203.0.113.99');
    expect(body.code).toBe('trace-api-unavailable');
    expect(body.node).toBe('203.0.113.99');
    expect(body.message).toMatch(/FreeSWITCH/);
    expect(body.message).toMatch(/migrate/i);
  });
});
