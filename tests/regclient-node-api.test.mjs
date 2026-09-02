import {
  decodePem,
  loadRegclientConfig,
  configurationProblem,
  assertNodeAddressAllowed,
  buildTraceUrl,
  buildProbeUrl,
  nodeRequest,
  describeNodeFailure,
  selectProbeNode,
  TRACE_FORMATS,
  TRACE_INDEX_FORMATS,
  wantsDebugTrace
} from '../lib/regclient.js';

// The regclient node API client: URL construction, the guard on which node
// addresses we are willing to send a bearer token to, and the mapping of
// transport failures onto something an operator can act on.

const baseEnv = {
  REGCLIENT_API_PORT: '8443',
  REGCLIENT_API_TOKEN: 'token-abc',
  REGCLIENT_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
};

describe('decodePem', () => {
  it('passes a literal PEM through', () => {
    expect(decodePem(baseEnv.REGCLIENT_CA_CERT)).toContain('BEGIN CERTIFICATE');
  });

  it('unwraps a base64-encoded PEM, as secretenv bundles carry it', () => {
    const b64 = Buffer.from(baseEnv.REGCLIENT_CA_CERT).toString('base64');
    expect(decodePem(b64)).toContain('BEGIN CERTIFICATE');
  });

  it('restores escaped newlines from single-line env values', () => {
    const escaped = '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
    expect(decodePem(escaped).split('\n')).toHaveLength(3);
  });

  it('returns null for junk and for empty values', () => {
    expect(decodePem('')).toBeNull();
    expect(decodePem(undefined)).toBeNull();
    expect(decodePem('not-a-certificate')).toBeNull();
  });
});

describe('loadRegclientConfig', () => {
  it('defaults port, scheme and timeout', () => {
    const config = loadRegclientConfig({ REGCLIENT_API_TOKEN: 'x' });
    expect(config.port).toBe(8443);
    expect(config.scheme).toBe('https');
    expect(config.timeoutMs).toBe(2000);
    expect(config.allowedNodes).toEqual([]);
  });

  it('honours an explicit timeout and allowlist', () => {
    const config = loadRegclientConfig({
      ...baseEnv,
      TRACE_PROXY_TIMEOUT_MS: '750',
      REGCLIENT_NODE_ALLOWLIST: '203.0.113.10, 203.0.113.11'
    });
    expect(config.timeoutMs).toBe(750);
    expect(config.allowedNodes).toEqual(['203.0.113.10', '203.0.113.11']);
  });

  it('only drops to http when insecure mode is explicitly requested', () => {
    expect(loadRegclientConfig({ REGCLIENT_API_SCHEME: 'http' }).scheme).toBe('https');
    expect(loadRegclientConfig({ REGCLIENT_API_SCHEME: 'http', REGCLIENT_API_INSECURE: '1' }).scheme).toBe('http');
  });
});

describe('configurationProblem', () => {
  it('is silent on a complete configuration', () => {
    expect(configurationProblem(loadRegclientConfig(baseEnv))).toBeNull();
  });

  it('names a missing token', () => {
    expect(configurationProblem(loadRegclientConfig({ ...baseEnv, REGCLIENT_API_TOKEN: '' })))
      .toMatch(/REGCLIENT_API_TOKEN/);
  });

  it('names a missing CA, unless verification was explicitly waived', () => {
    expect(configurationProblem(loadRegclientConfig({ ...baseEnv, REGCLIENT_CA_CERT: '' })))
      .toMatch(/REGCLIENT_CA_CERT/);
    expect(configurationProblem(loadRegclientConfig({ ...baseEnv, REGCLIENT_CA_CERT: '', REGCLIENT_API_INSECURE: '1' })))
      .toBeNull();
  });
});

describe('assertNodeAddressAllowed', () => {
  // b2buaId is normally written by the claiming node, but the public update API
  // also permits writing it (that is the migration lever), so it has to be
  // treated as caller-influenced: an unvalidated value would leak the node
  // bearer token to whatever host an attacker named.
  const config = loadRegclientConfig(baseEnv);

  it('allows a public node address', () => {
    expect(assertNodeAddressAllowed('203.0.113.10', config).ok).toBe(true);
  });

  it('allows a DNS name', () => {
    expect(assertNodeAddressAllowed('node1.b2bua.example.com', config).ok).toBe(true);
  });

  it('refuses cloud metadata and loopback', () => {
    expect(assertNodeAddressAllowed('169.254.169.254', config).ok).toBe(false);
    expect(assertNodeAddressAllowed('127.0.0.1', config).ok).toBe(false);
    expect(assertNodeAddressAllowed('localhost', config).ok).toBe(false);
    expect(assertNodeAddressAllowed('::1', config).ok).toBe(false);
  });

  it('refuses private ranges by default and permits them when a deployment opts in', () => {
    const permissive = loadRegclientConfig({ ...baseEnv, REGCLIENT_ALLOW_PRIVATE_NODES: '1' });
    for (const host of ['10.1.2.3', '192.168.1.5', '172.16.0.9', '100.64.0.1', 'fd00::1']) {
      expect(assertNodeAddressAllowed(host, config).ok).toBe(false);
      expect(assertNodeAddressAllowed(host, permissive).ok).toBe(true);
    }
  });

  it('never permits link-local, even for a deployment that allows private nodes', () => {
    const permissive = loadRegclientConfig({ ...baseEnv, REGCLIENT_ALLOW_PRIVATE_NODES: '1' });
    expect(assertNodeAddressAllowed('169.254.169.254', permissive).ok).toBe(false);
    expect(assertNodeAddressAllowed('fe80::1', permissive).ok).toBe(false);
  });

  it('refuses anything that is not a bare host', () => {
    for (const host of ['203.0.113.10/../x', 'http://203.0.113.10', 'user@203.0.113.10', '203.0.113.10:9/x', 'a b', '']) {
      expect(assertNodeAddressAllowed(host, config).ok).toBe(false);
    }
  });

  it('tolerates surrounding whitespace in a stored address', () => {
    expect(assertNodeAddressAllowed(' 203.0.113.10 ', config)).toEqual({ ok: true, host: '203.0.113.10' });
  });

  it('enforces an allowlist when one is configured', () => {
    const pinned = loadRegclientConfig({ ...baseEnv, REGCLIENT_NODE_ALLOWLIST: '203.0.113.10' });
    expect(assertNodeAddressAllowed('203.0.113.10', pinned).ok).toBe(true);
    expect(assertNodeAddressAllowed('203.0.113.99', pinned).ok).toBe(false);
  });
});

describe('URL construction', () => {
  const config = loadRegclientConfig(baseEnv);
  const registrationId = '11111111-2222-3333-4444-555555555555';

  it('builds the trace index URL without a redundant format', () => {
    expect(buildTraceUrl({ node: '203.0.113.10', registrationId }, config))
      .toBe(`https://203.0.113.10:8443/debug/registrations/${registrationId}/trace`);
  });

  // The index describes the exchanges; one exchange is fetched by id. That is
  // what keeps a dashboard listing from re-downloading tens of kilobytes of SIP
  // text every time it renders.
  it('addresses a single transaction by id', () => {
    expect(buildTraceUrl({ node: '203.0.113.10', registrationId, transactionId: 'reg-8' }, config))
      .toBe(`https://203.0.113.10:8443/debug/registrations/${registrationId}/trace/reg-8`);
  });

  it('escapes a transaction id rather than letting it reshape the path', () => {
    const url = buildTraceUrl({ node: '203.0.113.10', registrationId, transactionId: '../../probe' }, config);
    expect(url).not.toContain('/probe');
    expect(url).toContain('%2F');
  });

  it('carries format and since', () => {
    const url = new URL(buildTraceUrl({ node: '203.0.113.10', registrationId, format: 'decode', since: '2026-08-30T10:00:00Z' }, config));
    expect(url.searchParams.get('format')).toBe('decode');
    expect(url.searchParams.get('since')).toBe('2026-08-30T10:00:00Z');
    expect(url.searchParams.has('debug')).toBe(false);
  });

  // The node serves a call's customer leg unless asked for the platform leg
  // too; the flag is only sent when it is wanted, so the default stays the
  // node's default.
  it('asks for the platform leg only when debug is set', () => {
    const url = new URL(buildTraceUrl({ node: '203.0.113.10', registrationId, transactionId: 'call-3', debug: true }, config));
    expect(url.searchParams.get('debug')).toBe('1');
    for (const value of ['1', 'true', 'YES', true]) expect(wantsDebugTrace(value)).toBe(true);
    for (const value of ['0', 'false', '', undefined, null]) expect(wantsDebugTrace(value)).toBe(false);
  });

  it('brackets an IPv6 node address', () => {
    expect(buildTraceUrl({ node: '2001:db8::1', registrationId }, config))
      .toContain('https://[2001:db8::1]:8443/');
  });

  it('builds probe collection, report and event-stream URLs', () => {
    expect(buildProbeUrl({ node: '203.0.113.10' }, config)).toBe('https://203.0.113.10:8443/probe');
    expect(buildProbeUrl({ node: '203.0.113.10', probeId: 'p1' }, config)).toBe('https://203.0.113.10:8443/probe/p1');
    expect(buildProbeUrl({ node: '203.0.113.10', probeId: 'p1', events: true }, config)).toBe('https://203.0.113.10:8443/probe/p1/events');
  });

  it('offers exactly the three documented trace formats', () => {
    expect(TRACE_FORMATS).toEqual(['json', 'decode', 'pcap']);
  });

  // decode on the index would be the fat response the split exists to avoid.
  it('offers only listing and whole-registration capture on the index', () => {
    expect(TRACE_INDEX_FORMATS).toEqual(['json', 'pcap']);
  });
});

describe('nodeRequest', () => {
  const config = loadRegclientConfig(baseEnv);

  it('presents the bearer token, a hard timeout and no retries', async () => {
    let seen;
    await nodeRequest({
      url: 'https://203.0.113.10:8443/probe',
      config,
      requestImpl: async (request) => { seen = request; return { status: 200, data: {} }; }
    });
    expect(seen.headers.Authorization).toBe('Bearer token-abc');
    expect(seen.timeout).toBe(2000);
    expect(seen.maxRedirects).toBe(0);
    expect(seen.httpsAgent.options.ca).toContain('BEGIN CERTIFICATE');
    expect(seen.httpsAgent.options.rejectUnauthorized).toBe(true);
  });

  it('does not throw on a 4xx from the node — the caller decides what it means', async () => {
    const response = await nodeRequest({
      url: 'https://203.0.113.10:8443/probe',
      config,
      requestImpl: async (request) => ({ status: request.validateStatus(404) ? 404 : 0, data: {} })
    });
    expect(response.status).toBe(404);
  });
});

describe('describeNodeFailure', () => {
  it('names the node and translates transport errors', () => {
    expect(describeNodeFailure({ code: 'ECONNABORTED' }, '203.0.113.10'))
      .toEqual({ error: 'trace unavailable', node: '203.0.113.10', reason: 'timeout' });
    expect(describeNodeFailure({ code: 'ECONNREFUSED' }, 'n').reason).toBe('connection refused');
    expect(describeNodeFailure({ code: 'EHOSTUNREACH' }, 'n').reason).toBe('host unreachable');
    expect(describeNodeFailure({ message: 'unable to verify the first certificate' }, 'n').reason)
      .toBe('TLS verification failed');
  });
});

describe('selectProbeNode', () => {
  it('always uses the claiming node when there is one', () => {
    expect(selectProbeNode({
      registrationId: 'r1',
      claimedNode: '203.0.113.10',
      env: { REGCLIENT_PROBE_NODES: '198.51.100.1' }
    })).toBe('203.0.113.10');
  });

  it('picks deterministically from the pool for an unclaimed registration', () => {
    const env = { REGCLIENT_PROBE_NODES: '198.51.100.1,198.51.100.2,198.51.100.3' };
    const first = selectProbeNode({ registrationId: 'r1', claimedNode: null, env });
    expect(['198.51.100.1', '198.51.100.2', '198.51.100.3']).toContain(first);
    expect(selectProbeNode({ registrationId: 'r1', claimedNode: '', env })).toBe(first);
  });

  it('returns null when nothing can run the probe', () => {
    expect(selectProbeNode({ registrationId: 'r1', claimedNode: '', env: {} })).toBeNull();
  });
});
