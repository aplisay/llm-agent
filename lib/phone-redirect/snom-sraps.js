/**
 * Snom's redirection service (SRAPS). A factory-reset Snom phone asks it where
 * to fetch its settings. Binding a phone here is what lets it find the
 * provisioning service with nobody touching it.
 *
 * Every call is signed with Hawk. The key belongs to one SRAPS company.
 */
import { hawkHeader } from './hawk.js';

export const SRAPS_DEFAULT_URL = 'https://api.sraps.snom.com/api/v1/';
const USER_AGENT = 'aplisay-llm-agent';
const TIMEOUT_MS = 10000;

/** The adapter's settings, or null when SRAPS is not set up on this deployment. */
export function srapsConfig(env = process.env) {
  const keyId = String(env.SNOM_SRAPS_KEY_ID || '').trim();
  const keySecret = String(env.SNOM_SRAPS_KEY_SECRET || '').trim();
  const companyId = String(env.SNOM_SRAPS_COMPANY_ID || '').trim();
  if (!keyId || !keySecret || !companyId) return null;
  const baseUrl = `${String(env.SNOM_SRAPS_URL || SRAPS_DEFAULT_URL).trim().replace(/\/+$/, '')}/`;
  return { keyId, keySecret, companyId, baseUrl };
}

const isMac = (mac) => /^[0-9a-f]{12}$/.test(mac);

const errorText = (body) => {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 300);
  return String(body.detail ?? body.message ?? body.error ?? JSON.stringify(body)).slice(0, 300);
};

/** Why a call was refused, as a stable code. */
function refusalCode(status, text) {
  // The MAC is held by another SRAPS company, so only Snom or that company can free it.
  if (status === 409 || /already (taken|exists|registered)|another company/i.test(text)) return 'mac_taken';
  if (status === 401) return 'not_authorised';
  if (status === 402) return 'payment_required';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'service_error';
  return 'refused';
}

/**
 * @param {object} config   from srapsConfig
 * @param {object} [deps]   `fetch` and `now`, for tests
 * @returns {{ service, bind, unbind, status }}
 */
export function createSrapsAdapter(config, { fetch: fetchImpl = fetch, now = () => Date.now() } = {}) {
  let settingId = null;

  async function call(method, path, body) {
    const url = new URL(path, config.baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Authorization: hawkHeader({
        credentials: { id: config.keyId, key: config.keySecret },
        method,
        url,
        payload,
        contentType: 'application/json',
        now: now(),
      }),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    let response;
    try {
      response = await fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      return { ok: false, status: 0, code: 'unreachable', message: err?.message || 'request failed' };
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (response.ok) return { ok: true, status: response.status, body: parsed, link: response.headers.get('link') };
    const message = errorText(parsed);
    return { ok: false, status: response.status, code: refusalCode(response.status, message), message };
  }

  /** The id SRAPS gives the `setting_server` setting. Looked up once. */
  async function settingServerId() {
    if (settingId) return { ok: true, id: settingId };
    let path = 'settings/?page_size=1000';
    for (let page = 0; page < 20 && path; page += 1) {
      const answer = await call('GET', path);
      if (!answer.ok) return answer;
      const rows = Array.isArray(answer.body) ? answer.body : answer.body?.results || [];
      const found = rows.find((row) => row?.param_name === 'setting_server');
      if (found) {
        settingId = String(found.uuid ?? found.id);
        return { ok: true, id: settingId };
      }
      path = /<([^>]+)>;\s*rel="next"/.exec(answer.link || '')?.[1] || null;
    }
    return { ok: false, status: 0, code: 'setting_not_found', message: 'SRAPS lists no setting_server setting' };
  }

  const endpointPath = (mac) => `companies/${encodeURIComponent(config.companyId)}/endpoints/${mac}`;
  const badMac = { ok: false, status: 0, code: 'invalid_mac', message: 'not a MAC address' };

  return {
    service: 'snom-sraps',

    /** Point a phone at its settings address. Replaces an earlier binding of ours. */
    async bind(mac, url) {
      if (!isMac(mac)) return badMac;
      const setting = await settingServerId();
      if (!setting.ok) return setting;
      const answer = await call('PUT', endpointPath(mac), {
        mac,
        autoprovisioning_enabled: true,
        settings_manager: { [setting.id]: { value: url, attrs: {} } },
      });
      return answer.ok ? { ok: true } : answer;
    },

    /** Take a phone out of SRAPS. A phone that is not there counts as done. */
    async unbind(mac) {
      if (!isMac(mac)) return badMac;
      const answer = await call('DELETE', endpointPath(mac));
      return answer.ok || answer.status === 404 ? { ok: true } : answer;
    },

    /** What SRAPS holds for a phone, and when the phone last asked it. */
    async status(mac) {
      if (!isMac(mac)) return badMac;
      const answer = await call('GET', endpointPath(mac));
      if (answer.status === 404) return { ok: true, bound: false };
      if (!answer.ok) return answer;
      const meta = answer.body?.connection_metadata || {};
      return {
        ok: true,
        bound: true,
        settingServer: answer.body?.setting_server ?? null,
        // The names inside connection_metadata are not confirmed, so the whole object is passed on too.
        lastRequestAt: meta.last_provisioning_request ?? meta.last_request ?? meta.last_seen ?? null,
        firmware: meta.firmware_version ?? meta.firmware ?? null,
        connection: meta,
      };
    },
  };
}

const adapters = new Map();

/** The adapter for this deployment, or null when SRAPS is not set up. One for each set of settings, so the setting id is looked up once. */
export function srapsAdapter(env = process.env) {
  const config = srapsConfig(env);
  if (!config) return null;
  const key = JSON.stringify([config.baseUrl, config.companyId, config.keyId]);
  if (!adapters.has(key)) adapters.set(key, createSrapsAdapter(config));
  return adapters.get(key);
}
