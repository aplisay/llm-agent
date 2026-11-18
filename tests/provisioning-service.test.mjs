/**
 * Desk phone provisioning end to end: the provision and wipe routes, the
 * fetch handler and the HTTP server, on the test database. A test CA made
 * with openssl stands in for the phone vendor's CA.
 */
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import { setupRealDatabase, teardownRealDatabase, Organisation, PhoneRegistration } from './setup/database-test-wrapper.js';
import { makeTestCa } from './setup/test-ca.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const REALM = 'sip.prov.test.example';
const PUBLIC_URL = 'https://prov.test.example';
const UA = (model) => `Mozilla/4.0 (compatible; snom${model}-SIP 10.1.184.14 2010.12-00004-g5ae8e3e)`;

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
};

describe('desk phone provisioning', () => {
  let app;
  let api;
  let db;
  let savedEnv;
  let ca;
  let otherCa;
  let trust;
  let handleFetch;
  let serverModule;
  const users = {};
  const orgs = {};
  const made = {};
  const stamp = String(Date.now()).slice(-6);
  const mac = (n) => `000413${stamp.slice(-4)}${String(n).padStart(2, '0')}`;

  const call = (method) => (user, path, body) => {
    const req = request(api)[method](`/api${path}`).set('x-test-user', user);
    return body === undefined ? req : req.send(body);
  };
  const get = call('get');
  const post = call('post');
  const patch = call('patch');
  const del = call('delete');
  const ok = async (pending, status = 200) => {
    const res = await pending;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };

  const tokenOf = (url) => /\/snom\/([a-z2-7]{26})\/\{mac\}\.xml$/.exec(url)[1];
  const fetchFile = (overrides) => handleFetch({
    vendor: 'snom', trust, publicUrl: PUBLIC_URL, sourceIp: '192.0.2.10', userAgent: UA('D735'), ...overrides,
  });
  const lastLog = (deviceId) => db.DeviceFetchLog.findOne({ where: deviceId ? { deviceId } : {}, order: [['createdAt', 'DESC']] });
  const accountsOf = async (phoneId) => {
    const lines = await db.Line.findAll({ where: { phoneId }, order: [['position', 'ASC']] });
    const accounts = await PhoneRegistration.findAll({ where: { id: lines.map((line) => line.endpointId) } });
    return lines.map((line) => accounts.find((account) => account.id === line.endpointId));
  };
  const hashesIn = (xml) => [...xml.matchAll(/<user_hash idx="\d+" perm="R">([0-9a-f]{32})<\/user_hash>/g)].map((m) => m[1]);

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.PBX_REGISTRAR_DOMAIN = REALM;
    process.env.PROV_PUBLIC_URL = PUBLIC_URL;
    delete process.env.PBX_RELEASE;
    await setupRealDatabase();
    db = await import('../lib/database.js');
    ({ handleFetch } = await import('../lib/provisioning/service.js'));
    serverModule = await import('../lib/provisioning/server.js');
    const { loadTrust } = await import('../lib/provisioning/certificate.js');
    ca = makeTestCa('Test Phone');
    otherCa = makeTestCa('Another Maker');
    trust = { snom: loadTrust(ca.bundlePem, [ca.fingerprint]) };

    for (const name of ['a', 'b']) {
      orgs[name] = randomUUID();
      await Organisation.create({ id: orgs[name], name: `Provisioning test ${name}`, capabilities: ['phoneSystem'] });
    }
    Object.assign(users, {
      ownerA: { id: `prov-owner-a-${stamp}`, organisationId: orgs.a, role: 'owner' },
      memberA: { id: `prov-member-a-${stamp}`, organisationId: orgs.a, role: 'member' },
      ownerB: { id: `prov-owner-b-${stamp}`, organisationId: orgs.b, role: 'owner' },
      operator: { id: `prov-operator-${stamp}`, organisationId: null, role: 'superAdmin' },
    });

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.log = log;
      res.locals.user = users[req.headers['x-test-user']];
      next();
    });
    // Loaded one by one first: see tests/pbx-directory-api.test.mjs.
    const routeFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) return routeFiles(path);
      return item.name.endsWith('.js') ? [path] : [];
    });
    for (const top of ['directory', 'phones']) {
      const files = [...(fs.existsSync(`./api/paths/${top}.js`) ? [`./api/paths/${top}.js`] : []), ...routeFiles(`./api/paths/${top}`)];
      for (const file of files) await import(`.${file}`);
    }
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{directory,phones}{.js,/**/*.js}',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    api = await listen(app.listen ? (await import('node:http')).createServer(app) : app);

    // One person with her own extension and three teams: four lines.
    const entry = async (kind, name) => (await ok(post('ownerA', '/directory/entries', { kind, name }), 201)).entry;
    made.ada = await entry('person', 'Ada Byron');
    await ok(post('ownerA', '/directory/extensions', { number: '100', type: 'ring_all', entryId: made.ada.id }), 201);
    for (const [name, number] of [['Sales', '200'], ['Support', '201'], ['Accounts', '202']]) {
      const team = await entry('team', name);
      await ok(post('ownerA', '/directory/extensions', { number, type: 'ring_all', entryId: team.id, members: [made.ada.id] }), 201);
    }
    made.phone = (await ok(post('ownerA', '/phones', { kind: 'deskphone', mac: mac(1), model: 'D735', label: 'Ada desk', people: [made.ada.id] }), 201)).phone;
    made.cert = ca.issue(mac(1).toUpperCase());
  }, 120000);

  afterAll(async () => {
    await new Promise((resolve) => api.close(resolve));
    const where = { organisationId: Object.values(orgs) };
    for (const model of ['DeviceFetchLog', 'Line', 'PhoneChange', 'PhonePerson', 'PhoneRule', 'Phone', 'Device', 'ExtensionMember']) {
      await db[model].destroy({ where });
    }
    await PhoneRegistration.destroy({ where });
    await db.Extension.destroy({ where });
    await db.DirectoryEntry.destroy({ where });
    await Organisation.destroy({ where: { id: Object.values(orgs) } });
    ca.remove();
    otherCa.remove();
    process.env = savedEnv;
    await teardownRealDatabase();
  }, 60000);

  describe('the provision route', () => {
    test('needs phone:provision, the right organisation and a set-up deployment', async () => {
      const path = `/phones/${made.phone.id}/provision`;
      expect((await post('memberA', path)).status).toBe(403);
      expect((await post('ownerB', path)).status).toBe(404);
      delete process.env.PROV_PUBLIC_URL;
      const off = await post('ownerA', path);
      expect(off.status).toBe(503);
      expect(off.body.code).toBe('provisioning_unavailable');
      process.env.PROV_PUBLIC_URL = PUBLIC_URL;
    });

    test('gives the address once and keeps only its hash', async () => {
      expect(made.phone.lines).toHaveLength(4);
      const answer = await ok(post('ownerA', `/phones/${made.phone.id}/provision`));
      made.url = answer.provisioning.url;
      made.token = tokenOf(made.url);
      expect(made.url.startsWith(`${PUBLIC_URL}/snom/`)).toBe(true);
      const days = (new Date(answer.provisioning.expiresAt) - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
      expect(answer.phone.device).toMatchObject({ state: 'waiting', certificatePinned: false, lineLimit: null });

      const device = await db.Device.findByPk(made.phone.device.id);
      expect(device.tokenHash).toBe(createHash('sha256').update(made.token).digest('hex'));
      expect(device.tokenUsedAt).toBeNull();
      // No read shows the address or its hash.
      for (const path of [`/phones/${made.phone.id}`, '/phones']) {
        const text = JSON.stringify(await ok(get('ownerA', path)));
        expect(text).not.toContain(made.token);
        expect(text).not.toContain(device.tokenHash);
      }
    });
  });

  describe('a fetch', () => {
    const base = () => ({ token: made.token, file: `${mac(1).toUpperCase()}.xml`, certificate: made.cert.certificate });

    test('with no certificate is refused', async () => {
      const answer = await fetchFile({ ...base(), certificate: null });
      expect(answer).toMatchObject({ status: 404, body: '', result: 'no_certificate' });
      expect(await lastLog(made.phone.device.id)).toMatchObject({ result: 'no_certificate', statusCode: 404, bytes: 0, macInRequest: mac(1), sourceIp: '192.0.2.10' });
    });

    test('with a certificate from a CA that is not pinned is refused, whatever MAC it names', async () => {
      const forged = otherCa.issue(mac(1).toUpperCase());
      const answer = await fetchFile({ ...base(), certificate: forged.certificate, presented: [otherCa.intermediate, otherCa.root] });
      expect(answer).toMatchObject({ status: 404, body: '', result: 'certificate_untrusted' });
    });

    test('with another phone\'s certificate is refused and the phone is flagged', async () => {
      const second = ca.issue(mac(2).toUpperCase());
      const answer = await fetchFile({ ...base(), certificate: second.certificate });
      expect(answer).toMatchObject({ status: 404, body: '', result: 'certificate_mac_mismatch' });
      expect(await lastLog(made.phone.device.id)).toMatchObject({ result: 'certificate_mac_mismatch', certificateMac: mac(2) });
      expect((await ok(get('ownerA', `/phones/${made.phone.id}`))).device).toMatchObject({ state: 'waiting', failure: 'wrong_device' });
      // The second phone asking for the first one's file under its own MAC does no better.
      expect((await fetchFile({ ...base(), certificate: second.certificate, file: `${mac(2)}.xml` })).result).toBe('mac_mismatch');
    });

    test('of an address that names no phone, or a file that is not one, is refused the same way', async () => {
      const unknown = await fetchFile({ ...base(), token: 'a'.repeat(26) });
      const junk = await fetchFile({ ...base(), file: '../secrets.xml' });
      const vendor = await fetchFile({ ...base(), vendor: 'acme' });
      for (const answer of [unknown, junk, vendor]) {
        expect({ status: answer.status, body: answer.body, headers: answer.headers }).toEqual({ status: 404, body: '', headers: { 'Cache-Control': 'no-store' } });
      }
      expect([unknown.result, junk.result, vendor.result]).toEqual(['unknown_path', 'bad_request', 'bad_request']);
    });

    test('with the right certificate gets a file with every line and no password', async () => {
      const answer = await fetchFile(base());
      expect(answer.status).toBe(200);
      expect(answer.headers).toMatchObject({ 'Cache-Control': 'no-store', 'Content-Type': 'application/xml; charset=utf-8' });
      const accounts = await accountsOf(made.phone.id);
      expect(accounts).toHaveLength(4);
      expect(hashesIn(answer.body)).toEqual(accounts.map((account) => account.ha1));
      for (const account of accounts) {
        expect(answer.body).toContain(`<user_name idx="${accounts.indexOf(account) + 1}" perm="R">${account.username}</user_name>`);
        expect(account.getDataValue('password')).toBe('');
      }
      expect([...answer.body.matchAll(/<user_pass idx="\d+" perm="R">([^<]*)<\/user_pass>/g)].every((m) => m[1] === '')).toBe(true);
      expect(answer.body).toContain(`<user_host idx="1" perm="R">${REALM}</user_host>`);
      expect(answer.body).toContain(`<setting_server perm="R">${made.url}</setting_server>`);
      expect([...answer.body.matchAll(/<fkey [^>]*label="([^"]*)"/g)].map((m) => m[1])).toEqual(made.phone.lines.map((line) => line.label));

      const device = await db.Device.findByPk(made.phone.device.id);
      expect(device).toMatchObject({ provisioningState: 'fetched', fetchedVersion: device.configVersion, firmware: '10.1.184.14', reportedModel: 'D735' });
      expect(device.tokenUsedAt).not.toBeNull();
      expect(device.certificateFingerprint).toBe(made.cert.certificate.fingerprint256.replace(/:/g, '').toLowerCase());
      expect(await lastLog(device.id)).toMatchObject({ result: 'served', statusCode: 200, bytes: Buffer.byteLength(answer.body), certificateMac: mac(1) });
      expect((await ok(get('ownerA', `/phones/${made.phone.id}`))).device).toMatchObject({ state: 'fetched', certificatePinned: true, addressExpiresAt: null });
    });

    test('again by the same phone is served, and by a new certificate for the same MAC is refused', async () => {
      expect((await fetchFile(base())).status).toBe(200);
      const reissued = ca.issue(mac(1).toUpperCase());
      const answer = await fetchFile({ ...base(), certificate: reissued.certificate });
      expect(answer).toMatchObject({ status: 404, result: 'certificate_changed' });
    });

    test('of a replaced address is refused at once, and the new one works', async () => {
      const again = await ok(post('ownerA', `/phones/${made.phone.id}/provision`));
      const old = made.token;
      made.url = again.provisioning.url;
      made.token = tokenOf(made.url);
      expect(again.phone.device).toMatchObject({ state: 'waiting', failure: null });
      expect(await fetchFile({ ...base(), token: old })).toMatchObject({ status: 404, result: 'unknown_path' });
      expect((await fetchFile(base())).status).toBe(200);
    });

    test('of an address that ran out before its first use is refused', async () => {
      const again = await ok(post('ownerA', `/phones/${made.phone.id}/provision`));
      made.url = again.provisioning.url;
      made.token = tokenOf(made.url);
      const late = new Date(Date.now() + 8 * 86400000);
      expect(await fetchFile({ ...base(), now: late })).toMatchObject({ status: 404, result: 'token_expired' });
      expect((await fetchFile(base())).status).toBe(200);
      // Once used it does not run out: the phone fetches from it every day.
      expect((await fetchFile({ ...base(), now: late })).status).toBe(200);
    });
  });

  describe('the model and the line limit', () => {
    const base = () => ({ token: made.token, file: `${mac(1)}.xml`, certificate: made.cert.certificate });

    test('the phone wins: a different reported model replaces the typed one and the lines are worked out again', async () => {
      // A D717 takes three lines, so the fourth extension moves to the "Other" line.
      const answer = await fetchFile({ ...base(), userAgent: UA('D717') });
      expect(answer.status).toBe(200);
      const phone = await ok(get('ownerA', `/phones/${made.phone.id}`));
      expect(phone.device).toMatchObject({ model: 'D735', reportedModel: 'D717', state: 'fetched' });
      expect(phone.capacity).toBe(3);
      expect(phone.lines.map((line) => line.kind)).toEqual(['extension', 'extension', 'other']);
      expect(hashesIn(answer.body)).toHaveLength(3);
      expect(hashesIn(answer.body)).toEqual((await accountsOf(made.phone.id)).map((account) => account.ha1));
      const patched = await patch('ownerA', `/phones/${made.phone.id}`, { model: 'D785' });
      expect(patched.body.code).toBe('phone_model_reported');
    });

    test('a model we do not know is refused and flagged', async () => {
      const answer = await fetchFile({ ...base(), userAgent: UA('D999') });
      expect(answer).toMatchObject({ status: 404, result: 'model_not_supported' });
      expect((await ok(get('ownerA', `/phones/${made.phone.id}`))).device.failure).toBe('model_not_supported');
      expect((await fetchFile({ ...base(), userAgent: UA('D717') })).status).toBe(200);
      expect((await ok(get('ownerA', `/phones/${made.phone.id}`))).device.failure).toBeNull();
    });

    test('only an operator sets a line limit, and it lowers what the phone carries', async () => {
      const second = (await ok(post('ownerA', '/phones', { kind: 'deskphone', mac: mac(3), model: 'D735', label: 'Ada second', people: [made.ada.id] }), 201)).phone;
      expect(second.lines).toHaveLength(4);
      const refused = await patch('ownerA', `/phones/${second.id}`, { lineLimit: 3 });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('operator_only');
      expect((await patch('operator', `/phones/${second.id}?organisationId=${orgs.a}`, { lineLimit: 0 })).status).toBe(400);
      const limited = await ok(patch('operator', `/phones/${second.id}?organisationId=${orgs.a}`, { lineLimit: 3 }));
      expect(limited.phone.capacity).toBe(3);
      expect(limited.phone.device.lineLimit).toBe(3);
      expect(limited.phone.lines.map((line) => line.kind)).toEqual(['extension', 'extension', 'other']);
      expect(limited.phone.lines[2].covers).toHaveLength(2);
      const lifted = await ok(patch('operator', `/phones/${second.id}?organisationId=${orgs.a}`, { lineLimit: null }));
      expect(lifted.phone.lines).toHaveLength(4);
      made.second = second;
    });
  });

  describe('the HTTP server', () => {
    const path = () => `/snom/${made.token}/${mac(1)}.xml`;

    test('behind a proxy: the certificate header counts only from a trusted address', async () => {
      const config = (proxies) => ({
        publicUrl: PUBLIC_URL, trust, certificateHeader: 'ssl-client-cert',
        proxies: serverModule.provisioningConfig({
          PROV_PUBLIC_URL: PUBLIC_URL, PROV_SNOM_CA_FILE: 'ca', PROV_SNOM_CA_FINGERPRINTS: ca.fingerprint,
          PROV_CLIENT_CERT_HEADER: 'ssl-client-cert', PROV_TRUSTED_PROXIES: proxies,
        }, () => ca.bundlePem).proxies,
      });
      const header = encodeURIComponent(made.cert.pem);
      const trusted = await listen(serverModule.createProvisioningServer(config('127.0.0.1'), { handleFetch, logger: log }));
      const untrusted = await listen(serverModule.createProvisioningServer(config('10.99.0.0/16'), { handleFetch, logger: log }));
      try {
        const served = await request(trusted).get(path()).set('ssl-client-cert', header).set('User-Agent', UA('D717')).set('X-Forwarded-For', '203.0.113.9, 198.51.100.7');
        expect(served.status).toBe(200);
        expect(served.text).toContain('<user_hash idx="1"');
        expect((await lastLog(made.phone.device.id)).sourceIp).toBe('198.51.100.7');
        const ignored = await request(untrusted).get(path()).set('ssl-client-cert', header).set('User-Agent', UA('D717'));
        expect({ status: ignored.status, text: ignored.text }).toEqual({ status: 404, text: '' });
        expect((await lastLog(made.phone.device.id)).result).toBe('no_certificate');
        expect((await request(trusted).get(path())).status).toBe(404);
        expect((await request(trusted).get('/health')).text).toBe('ok');
        expect((await request(trusted).post(path()).set('ssl-client-cert', header)).status).toBe(404);
        expect((await request(trusted).get('/snom/x')).status).toBe(404);
      } finally {
        await new Promise((resolve) => trusted.close(resolve));
        await new Promise((resolve) => untrusted.close(resolve));
      }
    });

    test('ending TLS itself: the phone\'s own key and certificate fetch, and a client with none does not', async () => {
      const host = ca.issue('localhost');
      const server = await listen(serverModule.createProvisioningServer(
        { publicUrl: PUBLIC_URL, trust, tls: { cert: host.pem, key: host.key } }, { handleFetch, logger: log },
      ));
      const fetchOver = (options) => new Promise((resolve, reject) => {
        const req = https.get({
          host: '127.0.0.1', port: server.address().port, path: path(), rejectUnauthorized: false, agent: false,
          headers: { 'User-Agent': UA('D717') }, ...options,
        }, (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('error', reject);
      });
      try {
        // The phone sends its certificate and the intermediate. The root comes from the pinned bundle.
        const served = await fetchOver({ cert: `${made.cert.pem}\n${ca.intermediatePem}`, key: made.cert.key });
        expect(served.status).toBe(200);
        expect(served.text).toContain('<user_hash idx="1"');
        expect(await fetchOver({})).toEqual({ status: 404, text: '' });
        const stranger = otherCa.issue(mac(1).toUpperCase());
        expect(await fetchOver({ cert: stranger.pem, key: stranger.key })).toEqual({ status: 404, text: '' });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('wipe and removal', () => {
    const base = () => ({ token: made.token, file: `${mac(1)}.xml`, certificate: made.cert.certificate, userAgent: UA('D717') });

    test('a wipe stops the address and the line accounts, and provisioning brings the phone back', async () => {
      const before = await accountsOf(made.phone.id);
      expect((await post('memberA', `/phones/${made.phone.id}/wipe`)).status).toBe(403);
      expect((await post('ownerB', `/phones/${made.phone.id}/wipe`)).status).toBe(404);
      const wiped = await ok(post('ownerA', `/phones/${made.phone.id}/wipe`));
      expect(wiped.phone.device.state).toBe('wiped');
      expect(await fetchFile(base())).toMatchObject({ status: 404, body: '' });
      const after = await accountsOf(made.phone.id);
      expect(after.map((account) => account.status)).toEqual(before.map(() => 'disabled'));
      after.forEach((account, i) => expect(account.ha1).not.toBe(before[i].ha1));
      expect(after.every((account) => account.previousHa1 === null)).toBe(true);

      const back = await ok(post('ownerA', `/phones/${made.phone.id}/provision`));
      made.token = tokenOf(back.provisioning.url);
      expect(back.phone.device.state).toBe('waiting');
      expect((await accountsOf(made.phone.id)).every((account) => account.status === 'active')).toBe(true);
      const answer = await fetchFile(base());
      expect(answer.status).toBe(200);
      expect(hashesIn(answer.body)).toEqual((await accountsOf(made.phone.id)).map((account) => account.ha1));
    });

    test('an outside number is not provisioned or wiped', async () => {
      const mobile = (await ok(post('ownerA', '/phones', { kind: 'external', number: '+447700900123', label: 'Ada mobile', people: [made.ada.id] }), 201)).phone;
      expect((await post('ownerA', `/phones/${mobile.id}/provision`)).body.code).toBe('not_a_desk_phone');
      expect((await post('ownerA', `/phones/${mobile.id}/wipe`)).body.code).toBe('not_a_desk_phone');
    });

    test('removing a phone wipes it first', async () => {
      await ok(del('ownerA', `/phones/${made.phone.id}`));
      const device = await db.Device.findByPk(made.phone.device.id);
      expect(device).toMatchObject({ tokenHash: null, provisioningState: 'wiped' });
      expect(device.removedAt).not.toBeNull();
      expect(await fetchFile(base())).toMatchObject({ status: 404, body: '' });
    });
  });
});
