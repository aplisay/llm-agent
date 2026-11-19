/**
 * Answers one request from a desk phone for its settings file.
 *
 * A file is served only when all of these hold: the address names a device,
 * the file name carries that device's MAC, the phone presented a certificate
 * that chains to a pinned vendor root, and the MAC in that certificate is the
 * device's. The first certificate to fetch is pinned to the device. Every
 * refusal has the same status and an empty body. A request whose address
 * names a device is written to the fetch log. One that names none is only
 * counted, so the log cannot be filled from outside.
 */
import { Op } from 'sequelize';
import { Device, DeviceFetchLog, Line, Phone, PhoneRegistration } from '../database.js';
import logger from '../logger.js';
import { phoneProvisioningReady } from '../capabilities.js';
import { REGISTRAR_PORT } from '../registrar-accounts.js';
import { phoneModel } from '../pbx/phone-models.js';
import { restack } from '../pbx/reconcile.js';
import { getPhone } from '../pbx/directory-views.js';
import { verifyDeviceCertificate } from './certificate.js';
import { hashToken, TOKEN_RE } from './token.js';
import { renderSnomSettings, parseSnomUserAgent } from './snom.js';
import { deviceAdminPassword, settingServerUrl } from './address.js';

const FILE_RE = /^([0-9a-fA-F]{12})\.xml$/;
export const REFUSAL_STATUS = 404;

const FETCH_LOG_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
let unnamed = 0;

/** How many requests named no device since the last call. Resets the count. */
export function takeUnnamedCount() {
  const count = unnamed;
  unnamed = 0;
  return count;
}

/** How many days fetch log rows are kept, from PROV_FETCH_LOG_DAYS. */
export function fetchLogDays(env = process.env) {
  const days = Number(env.PROV_FETCH_LOG_DAYS);
  return Number.isInteger(days) && days > 0 ? days : FETCH_LOG_DAYS;
}

/** Delete fetch log rows older than the keep time. Idempotent. */
export async function purgeFetchLogs({ days = fetchLogDays(), now = Date.now() } = {}) {
  if (!phoneProvisioningReady()) return 0;
  return DeviceFetchLog.destroy({ where: { createdAt: { [Op.lt]: new Date(now - days * DAY_MS) } } });
}

/**
 * Run the purge once a day, and log how many requests named no device.
 * Started by the provisioning process only.
 * @returns {() => void} stop
 */
export function startFetchLogPurge({ intervalMs = DAY_MS, log = logger } = {}) {
  const run = () => purgeFetchLogs()
    .then((purged) => {
      const requests = takeUnnamedCount();
      if (purged || requests) log.info({ purged, requestsNamingNoDevice: requests }, 'provisioning: fetch log purge');
    })
    .catch((err) => log.warn({ err: err?.message }, 'provisioning: fetch log purge failed; it runs again tomorrow'));
  run();
  const timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

/** The fetch log row for an address that sent too many refused requests. One for each address and minute. */
export function logRateLimited({ vendor, file, sourceIp, userAgent }) {
  return writeLog({ vendor: vendor === 'snom' ? vendor : null, file, sourceIp, userAgent, result: 'rate_limited', statusCode: REFUSAL_STATUS, bytes: 0 });
}

async function writeLog(entry) {
  try {
    await DeviceFetchLog.create({
      ...entry,
      userAgent: entry.userAgent ? String(entry.userAgent).slice(0, 255) : null,
      file: entry.file ? String(entry.file).slice(0, 64) : null,
    });
  } catch (err) {
    logger.warn({ err: err?.message }, 'provisioning: could not write the fetch log');
  }
}

/** The lines of a phone as the settings file needs them, in key order. Null when a line has no usable account. */
async function linesForFile(organisationId, phoneId, transaction) {
  const view = await getPhone(organisationId, phoneId, { transaction });
  if (!view) return null;
  const rows = await Line.findAll({ where: { phoneId }, attributes: ['id', 'endpointId'], transaction });
  const endpointOf = new Map(rows.map((row) => [row.id, row.endpointId]));
  const accounts = new Map((await PhoneRegistration.findAll({
    where: { id: rows.map((row) => row.endpointId).filter(Boolean), organisationId, kind: 'device' },
    attributes: ['id', 'username', 'registrar', 'ha1', 'status'],
    transaction,
  })).map((account) => [account.id, account]));
  const lines = [];
  for (const line of view.lines) {
    const account = accounts.get(endpointOf.get(line.id));
    if (!account?.ha1 || account.status !== 'active') return null;
    lines.push({ key: line.key, label: line.label, username: account.username, ha1: account.ha1, registrar: account.registrar, port: REGISTRAR_PORT });
  }
  return lines;
}

/**
 * @param {object} request
 * @param {string} request.vendor
 * @param {string} request.token             the secret part of the address
 * @param {string} request.file              the file name asked for
 * @param {X509Certificate|null} request.certificate  the phone's certificate, already shown to belong to the caller by TLS
 * @param {X509Certificate[]} [request.presented]     other certificates the phone sent
 * @param {object} request.trust             vendor name to its trust set (loadTrust)
 * @param {string} request.publicUrl         this service's public base address
 * @param {string} [request.sourceIp]
 * @param {string} [request.userAgent]
 * @param {Date} [request.now]
 * @returns {Promise<{ status: number, body: string, headers: object, result: string }>}
 */
export async function handleFetch({ vendor, token, file, certificate, presented = [], trust, publicUrl, sourceIp, userAgent, now = new Date() }) {
  const log = { vendor: vendor === 'snom' ? vendor : null, file, sourceIp, userAgent };
  const refuse = async (result, { failure, device } = {}) => {
    if (failure && device) await Device.update({ failure }, { where: { id: device.id } });
    if (log.deviceId) await writeLog({ ...log, result, statusCode: REFUSAL_STATUS, bytes: 0 });
    else unnamed += 1;
    return { status: REFUSAL_STATUS, body: '', headers: { 'Cache-Control': 'no-store' }, result };
  };

  if (!phoneProvisioningReady()) return refuse('not_ready');
  const macInRequest = FILE_RE.exec(String(file ?? ''))?.[1].toLowerCase() ?? null;
  if (vendor !== 'snom' || !TOKEN_RE.test(String(token ?? '')) || !macInRequest || !trust?.[vendor]) return refuse('bad_request');
  log.macInRequest = macInRequest;

  const device = await Device.findOne({ where: { vendor, tokenHash: hashToken(token), removedAt: null } });
  if (!device) return refuse('unknown_path');
  log.deviceId = device.id;
  log.organisationId = device.organisationId;
  if (['wiping', 'wiped'].includes(device.provisioningState)) return refuse('revoked');
  if (macInRequest !== device.mac) return refuse('mac_mismatch');

  if (!certificate) return refuse('no_certificate');
  const checked = verifyDeviceCertificate(certificate, trust[vendor], { presented, now });
  if (!checked.ok) return refuse(checked.reason);
  log.certificateMac = checked.mac;
  log.certificateFingerprint = checked.fingerprint;
  // A real phone of this vendor, but not this one.
  if (checked.mac !== device.mac) return refuse('certificate_mac_mismatch', { failure: 'wrong_device', device });
  if (device.certificateFingerprint && device.certificateFingerprint !== checked.fingerprint) {
    return refuse('certificate_changed', { failure: 'wrong_device', device });
  }
  if (!device.tokenUsedAt && device.tokenExpiresAt && now > device.tokenExpiresAt) return refuse('token_expired');

  const reported = parseSnomUserAgent(userAgent);
  const reportedModel = reported ? phoneModel(vendor, reported.model) : null;
  if (reported && !reportedModel?.supported) return refuse('model_not_supported', { failure: 'model_not_supported', device });

  const served = await Device.sequelize.transaction(async (transaction) => {
    // The same lock a directory write takes: the lines may be worked out again below.
    await Device.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
      replacements: { key: `pbx-directory:${device.organisationId}` },
      transaction,
    });
    const row = await Device.findByPk(device.id, { transaction, lock: transaction.LOCK.UPDATE });
    const phone = await Phone.findOne({ where: { deviceId: row.id, removedAt: null }, attributes: ['id'], transaction });
    if (!phone || row.tokenHash !== device.tokenHash) return { refuse: 'not_ready' };
    // The checks above read the row before the lock. Another request may have changed it since.
    if (['wiping', 'wiped'].includes(row.provisioningState)) return { refuse: 'revoked' };
    if (row.certificateFingerprint && row.certificateFingerprint !== checked.fingerprint) {
      return { refuse: 'certificate_changed', failure: 'wrong_device' };
    }
    if (!row.tokenUsedAt && row.tokenExpiresAt && now > row.tokenExpiresAt) return { refuse: 'token_expired' };

    // The phone wins: what it says it is replaces what was typed, and its lines are worked out again.
    if (reportedModel && reportedModel.name !== (row.reportedModel || row.model)) {
      const typed = row.model;
      await row.update({ reportedModel: reportedModel.name }, { transaction });
      await restack({
        organisationId: row.organisationId,
        transaction,
        cause: { kind: 'model_reported', phoneId: phone.id, detail: { typed, reported: reportedModel.name } },
        actor: { kind: 'system', userId: null },
      });
      await row.reload({ transaction });
    } else if (reportedModel && !row.reportedModel) {
      await row.update({ reportedModel: reportedModel.name }, { transaction });
    }

    const lines = await linesForFile(row.organisationId, phone.id, transaction);
    if (!lines) return { refuse: 'not_ready' };
    const model = phoneModel(vendor, row.reportedModel || row.model);
    const body = renderSnomSettings({
      settingServer: settingServerUrl(publicUrl, token),
      identities: model?.identities ?? lines.length,
      keys: model?.lines,
      family: model?.family,
      adminPassword: deviceAdminPassword(row.id),
      lines,
    });
    await row.update({
      provisioningState: 'fetched',
      fetchedVersion: row.configVersion,
      lastFetchAt: now,
      certificateCheckedAt: now,
      tokenUsedAt: row.tokenUsedAt || now,
      certificateFingerprint: checked.fingerprint,
      certificateSerial: String(checked.serial).slice(0, 64),
      certificateIssuer: String(checked.issuer).slice(0, 255),
      ...(reported ? { firmware: reported.firmware.slice(0, 32) } : {}),
      ...(row.failure === 'model_not_supported' ? { failure: null } : {}),
    }, { transaction });
    return { body };
  });
  // After the commit, so the flag is not lost with a rolled-back transaction.
  if (served.refuse) return refuse(served.refuse, { failure: served.failure, device });

  const bytes = Buffer.byteLength(served.body, 'utf8');
  await writeLog({ ...log, result: 'served', statusCode: 200, bytes });
  return {
    status: 200,
    body: served.body,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    result: 'served',
  };
}
