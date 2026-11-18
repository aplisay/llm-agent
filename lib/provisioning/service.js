/**
 * Answers one request from a desk phone for its settings file.
 *
 * A file is served only when all of these hold: the address names a device,
 * the file name carries that device's MAC, the phone presented a certificate
 * that chains to a pinned vendor root, and the MAC in that certificate is the
 * device's. The first certificate to fetch is pinned to the device. Every
 * refusal has the same status and an empty body, and every request is logged.
 */
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
    await writeLog({ ...log, result, statusCode: REFUSAL_STATUS, bytes: 0 });
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
    if (!phone || row.tokenHash !== device.tokenHash) return null;

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
    if (!lines) return null;
    const model = phoneModel(vendor, row.reportedModel || row.model);
    const body = renderSnomSettings({
      settingServer: settingServerUrl(publicUrl, token),
      identities: model?.identities ?? lines.length,
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
    return body;
  });
  if (served == null) return refuse('not_ready');

  const bytes = Buffer.byteLength(served, 'utf8');
  await writeLog({ ...log, result: 'served', statusCode: 200, bytes });
  return {
    status: 200,
    body: served,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    result: 'served',
  };
}
