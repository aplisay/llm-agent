/**
 * The Snom redirection adapter, against a stand-in service that checks the
 * Hawk signature of every call. No test reaches Snom.
 */
import { hawkHeader, payloadHash, requestMac } from '../lib/phone-redirect/hawk.js';
import { srapsConfig, createSrapsAdapter, SRAPS_DEFAULT_URL } from '../lib/phone-redirect/snom-sraps.js';
import { startSrapsStandIn } from './setup/sraps-stand-in.js';

const KEY = { keyId: 'stand-in-key-id', keySecret: 'stand-in-key-secret', companyId: 'c0ffee00c0ffee00c0ffee00c0ffee00' };
const MAC = '000413a1b2c3';
const URL_FOR_PHONE = 'https://prov.example.net/snom/abcdefghijklmnopqrstuvwxyz/{mac}.xml';

describe('Hawk signing', () => {
  // The worked examples of the Hawk documentation.
  const credentials = { id: 'dh37fgj492je', key: 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn' };

  test('a GET gives the documented mac', () => {
    expect(requestMac({
      key: credentials.key, ts: 1353832234, nonce: 'j4h3g2', method: 'GET', resource: '/resource/1?b=1&a=2',
      host: 'example.com', port: 8000, ext: 'some-app-ext-data',
    })).toBe('6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE=');
  });

  test('a POST with a body gives the documented payload hash and mac', () => {
    const hash = payloadHash('Thank you for flying Hawk', 'text/plain');
    expect(hash).toBe('Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=');
    expect(requestMac({
      key: credentials.key, ts: 1353832234, nonce: 'j4h3g2', method: 'POST', resource: '/resource/1?b=1&a=2',
      host: 'example.com', port: 8000, hash, ext: 'some-app-ext-data',
    })).toBe('aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw=');
  });

  test('the header carries id, ts, nonce and mac, and a hash only with a body', () => {
    const plain = hawkHeader({ credentials, method: 'GET', url: 'https://api.example.net/v1/x?y=1', now: 1353832234000, nonce: 'abc' });
    expect(plain).toMatch(/^Hawk id="dh37fgj492je", ts="1353832234", nonce="abc", mac="[A-Za-z0-9+/]+=*"$/);
    const withBody = hawkHeader({ credentials, method: 'PUT', url: 'https://api.example.net/v1/x', payload: '{}', contentType: 'application/json; charset=utf-8', now: 1353832234000, nonce: 'abc' });
    expect(withBody).toContain(`hash="${payloadHash('{}', 'application/json')}"`);
    // The default port of the scheme is signed when the address names none.
    expect(plain).toContain(`mac="${requestMac({ key: credentials.key, ts: 1353832234, nonce: 'abc', method: 'GET', resource: '/v1/x?y=1', host: 'api.example.net', port: 443 })}"`);
  });
});

describe('the adapter settings', () => {
  test('all three values are needed, and the address defaults to Snom\'s', () => {
    expect(srapsConfig({})).toBeNull();
    expect(srapsConfig({ SNOM_SRAPS_KEY_ID: 'a', SNOM_SRAPS_KEY_SECRET: 'b' })).toBeNull();
    expect(srapsConfig({ SNOM_SRAPS_KEY_ID: 'a', SNOM_SRAPS_KEY_SECRET: 'b', SNOM_SRAPS_COMPANY_ID: 'c' }))
      .toEqual({ keyId: 'a', keySecret: 'b', companyId: 'c', baseUrl: SRAPS_DEFAULT_URL });
    expect(srapsConfig({ SNOM_SRAPS_KEY_ID: 'a', SNOM_SRAPS_KEY_SECRET: 'b', SNOM_SRAPS_COMPANY_ID: 'c', SNOM_SRAPS_URL: 'http://127.0.0.1:1/api/v1' }).baseUrl)
      .toBe('http://127.0.0.1:1/api/v1/');
  });
});

describe('the adapter against the stand-in', () => {
  let sraps;
  let adapter;

  beforeAll(async () => {
    sraps = await startSrapsStandIn(KEY);
    adapter = createSrapsAdapter({ ...KEY, baseUrl: sraps.url });
  });
  afterAll(() => sraps.close());

  test('bind looks up the setting once, then creates the endpoint with the redirect', async () => {
    expect(await adapter.bind(MAC, URL_FOR_PHONE)).toEqual({ ok: true });
    expect(sraps.state.refusals).toEqual([]);
    const put = sraps.state.requests.find((request) => request.method === 'PUT');
    expect(put.url).toBe(`/api/v1/companies/${KEY.companyId}/endpoints/${MAC}`);
    expect(put.body).toEqual({
      mac: MAC,
      autoprovisioning_enabled: true,
      settings_manager: { [sraps.settingServerId]: { value: URL_FOR_PHONE, attrs: {} } },
    });
    // A second bind replaces the first and does not look the setting up again.
    expect(await adapter.bind(MAC, `${URL_FOR_PHONE}?2`)).toEqual({ ok: true });
    expect(sraps.state.settingsCalls).toBe(1);
    expect(sraps.state.endpoints.get(MAC).setting_server).toBe(`${URL_FOR_PHONE}?2`);
  });

  test('status says what is bound and when the phone last asked', async () => {
    expect(await adapter.status(MAC)).toMatchObject({ ok: true, bound: true, settingServer: `${URL_FOR_PHONE}?2`, lastRequestAt: null, firmware: null });
    sraps.phoneCalledIn(MAC, '10.1.184.14');
    const after = await adapter.status(MAC);
    expect(after.firmware).toBe('10.1.184.14');
    expect(new Date(after.lastRequestAt).getTime()).toBeGreaterThan(Date.now() - 60000);
    expect(await adapter.status('000413ffffff')).toEqual({ ok: true, bound: false });
  });

  test('a MAC another company holds is reported as taken', async () => {
    sraps.state.taken.add('000413aaaaaa');
    expect(await adapter.bind('000413aaaaaa', URL_FOR_PHONE)).toMatchObject({ ok: false, status: 409, code: 'mac_taken', message: 'MAC already taken' });
    expect(sraps.state.endpoints.has('000413aaaaaa')).toBe(false);
  });

  test('unbind removes the endpoint, and a phone that is not there counts as done', async () => {
    expect(await adapter.unbind(MAC)).toEqual({ ok: true });
    expect(sraps.state.endpoints.has(MAC)).toBe(false);
    expect(await adapter.unbind(MAC)).toEqual({ ok: true });
    expect(await adapter.status(MAC)).toEqual({ ok: true, bound: false });
  });

  test('other refusals come back with a code and are not thrown', async () => {
    sraps.state.failNext = { status: 402, detail: 'Payment required' };
    expect(await adapter.bind(MAC, URL_FOR_PHONE)).toMatchObject({ ok: false, code: 'payment_required' });
    sraps.state.failNext = { status: 500, detail: 'boom' };
    expect(await adapter.status(MAC)).toMatchObject({ ok: false, code: 'service_error' });
    expect(await adapter.bind('not-a-mac', URL_FOR_PHONE)).toMatchObject({ ok: false, code: 'invalid_mac' });
    const down = createSrapsAdapter({ ...KEY, baseUrl: 'http://127.0.0.1:1/api/v1/' });
    expect(await down.unbind(MAC)).toMatchObject({ ok: false, code: 'unreachable' });
  });

  test('the stand-in refuses a wrong secret, a clock more than a minute out and a changed body', async () => {
    const before = sraps.state.requests.length;
    const wrongKey = createSrapsAdapter({ ...KEY, keySecret: 'not-the-secret', baseUrl: sraps.url });
    expect(await wrongKey.status(MAC)).toMatchObject({ ok: false, status: 401, code: 'not_authorised', message: 'bad mac' });
    const slowClock = createSrapsAdapter({ ...KEY, baseUrl: sraps.url }, { now: () => Date.now() - 5 * 60 * 1000 });
    // The service says its own time, so the refusal names the clock.
    const slow = await slowClock.status(MAC);
    expect(slow).toMatchObject({ ok: false, status: 401, code: 'clock_skew' });
    expect(slow.message).toMatch(/clock differs from the service's by -(29\d|30\d) seconds/);
    const tamper = createSrapsAdapter({ ...KEY, baseUrl: sraps.url }, {
      fetch: (url, options) => fetch(url, options.body ? { ...options, body: options.body.replace('prov.example.net', 'evil.example.net') } : options),
    });
    expect(await tamper.bind(MAC, URL_FOR_PHONE)).toMatchObject({ ok: false, code: 'not_authorised', message: 'payload hash does not match' });
    const unsigned = await fetch(`${sraps.url}companies/${KEY.companyId}/endpoints/${MAC}`, { headers: { Accept: 'application/json' } });
    expect(unsigned.status).toBe(401);
    // None of the refused calls reached the service behind the check. The tampering adapter's
    // setting look-up has no body, so that one call is signed correctly and counts.
    expect(sraps.state.requests.length - before).toBe(1);
  });
});
