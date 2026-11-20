// A stand-in for call control's resync route, for tests. It checks the token,
// keeps what it was sent, and answers each phone with the state it was told to.
import http from 'node:http';

export async function startCallctlStandIn({ token }) {
  const state = {
    requests: [],
    refused: [],
    // deviceId -> state to answer. Anything else gets `sent`.
    answers: new Map(),
    // Set to a status to answer every request with it.
    failWith: null,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method !== 'POST' || req.url !== '/phones/resync') return send(404, { code: 'not_found' });
      if (req.headers['x-callctl-token'] !== token) {
        state.refused.push('token');
        return send(401, { code: 'not_authorised' });
      }
      let sent;
      try {
        sent = JSON.parse(body);
      } catch {
        return send(400, { code: 'invalid_request' });
      }
      if (!Array.isArray(sent.phones) || !sent.requestId) return send(400, { code: 'invalid_request' });
      if (sent.phones.length > 100) return send(413, { code: 'too_many_phones' });
      state.requests.push({ headers: req.headers, body: sent });
      if (state.failWith) return send(state.failWith, { code: 'resync_unavailable' });
      return send(202, {
        results: sent.phones.map((phone) => ({
          deviceId: phone.deviceId,
          state: phone.action === 'check-sync' ? state.answers.get(phone.deviceId) || 'sent' : 'unknown_action',
        })),
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    /** Every phone sent so far, across requests. */
    phones: () => state.requests.flatMap((request) => request.body.phones),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
