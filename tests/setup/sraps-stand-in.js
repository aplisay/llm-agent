// A stand-in for Snom's redirection service, for tests. It checks the Hawk
// signature of every call with its own code, not the adapter's, and keeps
// endpoints in memory. Nothing here reaches Snom.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const SETTING_SERVER_ID = '6c2f1f0e-5a0b-4c57-9a57-1f0a2d3e4b5c';

const attributes = (header) => Object.fromEntries([...String(header).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

export async function startSrapsStandIn({ keyId, keySecret, companyId }) {
  const state = {
    endpoints: new Map(),
    // MACs another company holds.
    taken: new Set(),
    requests: [],
    refusals: [],
    nonces: new Set(),
    settingsCalls: 0,
    failNext: null,
  };

  const check = (req, body) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Hawk ')) return 'no Hawk header';
    if (!req.headers.accept || !req.headers['user-agent']) return 'Accept and User-Agent are required';
    const { id, ts, nonce, hash, mac } = attributes(auth);
    if (id !== keyId) return 'unknown key id';
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 60) return 'stale timestamp';
    if (state.nonces.has(`${ts}:${nonce}`)) return 'nonce used twice';
    if (body) {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const expected = createHash('sha256').update(`hawk.1.payload\n${type}\n${body}\n`).digest('base64');
      if (hash !== expected) return 'payload hash does not match';
    }
    const [host, port] = req.headers.host.split(':');
    const text = ['hawk.1.header', ts, nonce, req.method, req.url, host, port, hash || '', '', ''].join('\n');
    const expected = createHmac('sha256', keySecret).update(text).digest();
    const given = Buffer.from(mac || '', 'base64');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'bad mac';
    state.nonces.add(`${ts}:${nonce}`);
    return null;
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(value === undefined ? '' : JSON.stringify(value));
      };
      const problem = check(req, body);
      if (problem) {
        state.refusals.push(problem);
        return send(401, { detail: problem });
      }
      state.requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (state.failNext) {
        const { status, detail } = state.failNext;
        state.failNext = null;
        return send(status, { detail });
      }
      const url = new URL(req.url, 'http://stand-in');
      if (req.method === 'GET' && url.pathname === '/api/v1/settings/') {
        state.settingsCalls += 1;
        return send(200, [
          { uuid: '11111111-2222-3333-4444-555555555555', param_name: 'language' },
          { uuid: SETTING_SERVER_ID, param_name: 'setting_server' },
        ]);
      }
      const match = new RegExp(`^/api/v1/companies/${companyId}/endpoints/([0-9a-f]{12})$`).exec(url.pathname);
      if (!match) return send(404, { detail: 'Not found.' });
      const mac = match[1];
      if (req.method === 'PUT') {
        if (state.taken.has(mac)) return send(409, { detail: 'MAC already taken' });
        const sent = JSON.parse(body);
        if (sent.mac !== mac || typeof sent.autoprovisioning_enabled !== 'boolean') return send(400, { detail: 'mac and autoprovisioning_enabled are required' });
        const created = !state.endpoints.has(mac);
        state.endpoints.set(mac, { ...sent, setting_server: sent.settings_manager?.[SETTING_SERVER_ID]?.value ?? null, connection_metadata: {} });
        return send(created ? 201 : 200, state.endpoints.get(mac));
      }
      if (req.method === 'GET') {
        return state.endpoints.has(mac) ? send(200, state.endpoints.get(mac)) : send(404, { detail: 'Not found.' });
      }
      if (req.method === 'DELETE') {
        return state.endpoints.delete(mac) ? send(204) : send(404, { detail: 'Not found.' });
      }
      return send(405, { detail: 'Method not allowed.' });
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    state,
    settingServerId: SETTING_SERVER_ID,
    url: `http://127.0.0.1:${server.address().port}/api/v1/`,
    /** Record that the phone called in, as the real service would. */
    phoneCalledIn(mac, firmware) {
      const endpoint = state.endpoints.get(mac);
      if (endpoint) endpoint.connection_metadata = { last_provisioning_request: new Date().toISOString(), firmware_version: firmware };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
