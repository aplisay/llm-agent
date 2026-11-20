/**
 * Asks call control to tell desk phones to fetch their settings.
 *
 * A phone is asked when its settings changed after it last fetched (state
 * `updating`). The ask is written on the device row first and sent second, so
 * two API servers never both send it. Nothing reports that the phone was
 * told: the proof is its next fetch, which the provisioning service records.
 * Until then the sweep asks again (lib/pbx/resync-rules.js).
 */
import { randomUUID } from 'node:crypto';
import { Op, col, where as sqlWhere } from 'sequelize';
import { Device, Line, Phone, PhoneRegistration } from '../database.js';
import defaultLogger from '../logger.js';
import { phoneResyncReady } from '../capabilities.js';
import { resyncDue, callctlTarget, RESYNC_BATCH, RESYNC_TIMEOUT_MS, RESYNC_STATES } from './resync-rules.js';

/** The SIP usernames of a phone's active line accounts, in key order. */
async function lineNames(phoneId, organisationId) {
  const lines = await Line.findAll({ where: { phoneId }, attributes: ['endpointId', 'position'], order: [['position', 'ASC']] });
  const ids = lines.map((line) => line.endpointId).filter(Boolean);
  if (!ids.length) return [];
  const accounts = new Map((await PhoneRegistration.findAll({
    where: { id: ids, organisationId, kind: 'device', status: 'active' },
    attributes: ['id', 'username'],
  })).map((account) => [account.id, account.username]));
  return lines.map((line) => accounts.get(line.endpointId)).filter(Boolean);
}

/**
 * Find the phones that should be asked now and record the ask on each.
 * @returns {Promise<object[]>} the `phones` of a request to call control
 */
export async function claimDueResyncs({ organisationId, limit = RESYNC_BATCH, now = Date.now() } = {}) {
  const candidates = await Device.findAll({
    where: {
      ...(organisationId ? { organisationId } : {}),
      removedAt: null,
      provisioningState: 'updating',
      [Op.and]: [sqlWhere(col('fetched_version'), Op.lt, col('config_version'))],
    },
    // Never asked first, then the longest wait.
    order: [[col('resync_requested_at'), 'ASC NULLS FIRST']],
    limit: limit * 4,
  });
  const phones = [];
  for (const device of candidates) {
    if (phones.length >= limit) break;
    const { due, attempts } = resyncDue(device, now);
    if (!due) continue;
    const phone = await Phone.findOne({ where: { deviceId: device.id, removedAt: null }, attributes: ['id'] });
    const lines = phone ? await lineNames(phone.id, device.organisationId) : [];
    // The guard on the old values makes this ask belong to one server only.
    const [claimed] = await Device.update({
      resyncVersion: device.configVersion,
      resyncRequestedAt: new Date(now),
      resyncAttempts: attempts + 1,
      resyncState: lines.length ? 'asked' : 'no_lines',
    }, {
      where: {
        id: device.id,
        configVersion: device.configVersion,
        provisioningState: 'updating',
        resyncVersion: device.resyncVersion ?? null,
        resyncAttempts: device.resyncAttempts ?? null,
      },
    });
    if (!claimed || !lines.length) continue;
    phones.push({
      deviceId: device.id,
      phoneId: phone.id,
      organisationId: device.organisationId,
      configVersion: device.configVersion,
      action: 'check-sync',
      lines,
    });
  }
  return phones;
}

/**
 * Send one request to call control and note its answer for each phone.
 * Never throws: an ask that fails is made again by the sweep.
 * @returns {Promise<{ ok: boolean, status: number, states: object }>}
 */
export async function sendResync(phones, { target = callctlTarget(), fetch: fetchImpl = fetch, log = defaultLogger } = {}) {
  if (!phones.length || !target) return { ok: false, status: 0, states: {} };
  const requestId = randomUUID();
  let status = 0;
  let results = [];
  try {
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'aplisay-llm-agent', 'x-callctl-token': target.token },
      body: JSON.stringify({ requestId, phones }),
      signal: AbortSignal.timeout(RESYNC_TIMEOUT_MS),
    });
    status = response.status;
    const body = await response.json().catch(() => null);
    if (response.ok && Array.isArray(body?.results)) results = body.results;
    else log.error({ requestId, status, code: body?.code, phones: phones.length }, 'phone resync: call control refused the request');
  } catch (err) {
    log.warn({ requestId, err: err?.message, phones: phones.length }, 'phone resync: call control could not be reached');
  }
  const states = {};
  const asked = new Map(phones.map((phone) => [phone.deviceId, phone.configVersion]));
  for (const result of results) {
    if (!asked.has(result?.deviceId) || !RESYNC_STATES.includes(result?.state)) continue;
    states[result.deviceId] = result.state;
    // Only while the row still holds this ask.
    await Device.update({ resyncState: result.state }, { where: { id: result.deviceId, resyncVersion: asked.get(result.deviceId) } });
  }
  const missing = phones.filter((phone) => !states[phone.deviceId]).map((phone) => phone.deviceId);
  if (missing.length) await Device.update({ resyncState: 'unanswered' }, { where: { id: missing, resyncState: 'asked' } });
  if (results.length) log.info({ requestId, phones: phones.length, states }, 'phone resync: asked call control');
  return { ok: status >= 200 && status < 300, status, states };
}

/** Ask for every phone that is due, of one organisation or of all. Never throws. */
export async function requestResyncs({ organisationId, log = defaultLogger, now, fetch: fetchImpl, target = callctlTarget() } = {}) {
  try {
    // With no call control set nothing is recorded either, so the first ask is still made once it is.
    if (!target || !phoneResyncReady()) return { asked: 0 };
    const phones = await claimDueResyncs({ organisationId, now });
    if (!phones.length) return { asked: 0 };
    const answer = await sendResync(phones, { target, fetch: fetchImpl, log });
    return { asked: phones.length, ...answer };
  } catch (err) {
    log.warn({ err: err?.message }, 'phone resync: could not ask');
    return { asked: 0 };
  }
}

/**
 * After a directory write has committed: ask for that organisation's phones.
 * Not awaited by the caller, so the API answer does not wait for call control.
 */
export function resyncAfterWrite(organisationId) {
  if (!callctlTarget() || !phoneResyncReady()) return null;
  return requestResyncs({ organisationId });
}

/**
 * Once a minute: ask again for phones that have not fetched yet. Started by
 * the server only.
 * @returns {() => void} stop
 */
export function startResyncSweep({ intervalMs = 60 * 1000, log = defaultLogger, databaseStarted = Promise.resolve() } = {}) {
  let timer = null;
  let stopped = false;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await requestResyncs({ log });
    } finally {
      running = false;
    }
  };
  databaseStarted.then(() => {
    if (stopped) return;
    timer = setInterval(run, intervalMs);
    if (timer.unref) timer.unref();
  });
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}
