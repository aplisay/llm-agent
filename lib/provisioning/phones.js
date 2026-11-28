/**
 * What the API does to a desk phone's provisioning: give it a settings
 * address, and wipe it.
 */
import { Op } from 'sequelize';
import { Device, Line, Organisation, Phone, PhoneRegistration } from '../database.js';
import { phoneProvisioningReady, hasCapability } from '../capabilities.js';
import { PbxError } from '../pbx/errors.js';
import { mintLineHash } from '../pbx/line-password.js';
import { getPhone } from '../pbx/directory-views.js';
import { phoneModel } from '../pbx/phone-models.js';
import { mintToken, hashToken, tokenExpiry, TOKEN_DAYS, TOKEN_DAYS_REDIRECTED } from './token.js';
import { srapsAdapter } from '../phone-redirect/snom-sraps.js';
import logger from '../logger.js';
import { provisioningPublicUrl, settingServerUrl } from './address.js';

const NOT_READY = () => new PbxError(503, 'phone_provisioning_not_ready',
  'Phone provisioning needs a database upgrade. Run tools/agent-admin.js upgrade-db, then restart the API server.');

/** Run `fn` on a live desk phone and its device, inside the organisation's directory lock. */
async function withDeskPhone(ctx, phoneId, fn) {
  if (!phoneProvisioningReady()) throw NOT_READY();
  const organisationId = ctx.organisation.id;
  return Device.sequelize.transaction(async (transaction) => {
    await Device.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
      replacements: { key: `pbx-directory:${organisationId}` },
      transaction,
    });
    const phone = await Phone.findOne({ where: { id: phoneId, organisationId, removedAt: null }, transaction });
    if (!phone) throw new PbxError(404, 'not_found', 'Phone not found');
    const device = phone.deviceId ? await Device.findByPk(phone.deviceId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (phone.kind !== 'deskphone' || !device) {
      throw new PbxError(409, 'not_a_desk_phone', 'Only a desk phone is provisioned.');
    }
    return fn({ phone, device, organisationId, transaction });
  });
}

const lineAccounts = async (phoneId, organisationId, transaction) => {
  const lines = await Line.findAll({ where: { phoneId }, attributes: ['endpointId'], transaction });
  return PhoneRegistration.findAll({
    where: { id: lines.map((line) => line.endpointId).filter(Boolean), organisationId, kind: 'device' },
    transaction,
  });
};

/** The redirect service for a vendor's phones on this deployment, or null. */
const redirectFor = (vendor) => (vendor === 'snom' ? srapsAdapter() : null);

/**
 * Tell the vendor's redirect service where a phone fetches its settings, and
 * record the outcome on the device. Never throws: without the redirect the
 * address can still be typed into the phone.
 */
async function bindRedirect(deviceId, url, now) {
  const device = await Device.findByPk(deviceId);
  const adapter = device && redirectFor(device.vendor);
  if (!adapter) return null;
  // A binding is made in the platform's name at the vendor, so an operator decides which organisations may make one.
  const organisation = await Organisation.findByPk(device.organisationId, { attributes: ['id', 'capabilities'] });
  if (!hasCapability(organisation, 'phoneRedirect')) return { service: adapter.service, bound: false, error: 'not_allowed' };
  const answer = await adapter.bind(device.mac, url);
  if (answer.ok) {
    // A phone can sit in its box for a while once the redirect knows its address.
    await device.update({ srapsEndpointId: device.mac, tokenExpiresAt: tokenExpiry(TOKEN_DAYS_REDIRECTED, now) });
    return { service: adapter.service, bound: true, expiresAt: device.tokenExpiresAt };
  }
  logger.warn({ deviceId, service: adapter.service, code: answer.code, status: answer.status }, 'phone redirect: bind refused');
  // Held by another company at the vendor: only they can free it.
  if (answer.code === 'mac_taken') await device.update({ failure: 'other_provider' });
  return { service: adapter.service, bound: false, error: answer.code };
}

/**
 * Take a phone out of the vendor's redirect service, if we put it there.
 * Never throws. A failure leaves the record, and the daily sweep tries again.
 */
export async function releaseRedirect(deviceId) {
  const device = deviceId ? await Device.findByPk(deviceId) : null;
  if (!device?.srapsEndpointId) return null;
  const adapter = redirectFor(device.vendor);
  if (!adapter) return null;
  // The service holds one binding for a MAC. When a later row for the same phone holds it now,
  // this row's record is stale: drop the record and leave the binding alone.
  const holder = await Device.findOne({
    where: {
      id: { [Op.ne]: device.id },
      vendor: device.vendor,
      mac: device.mac,
      srapsEndpointId: { [Op.ne]: null },
      removedAt: null,
      provisioningState: { [Op.ne]: 'wiped' },
    },
    attributes: ['id'],
  });
  if (holder) {
    await device.update({ srapsEndpointId: null });
    return { service: adapter.service, bound: false };
  }
  const answer = await adapter.unbind(device.mac);
  if (answer.ok) {
    await device.update({ srapsEndpointId: null });
    return { service: adapter.service, bound: false };
  }
  logger.warn({ deviceId, service: adapter.service, code: answer.code, status: answer.status }, 'phone redirect: unbind refused');
  return { service: adapter.service, bound: true, error: answer.code };
}

/**
 * Try again for phones that were removed or wiped while the redirect service
 * could not be reached, and so are still bound there. Needs no capability:
 * a release is always allowed.
 * @returns {Promise<{ tried: number, released: number }>}
 */
export async function sweepRedirects() {
  if (!phoneProvisioningReady() || !redirectFor('snom')) return { tried: 0, released: 0 };
  const devices = await Device.findAll({
    where: {
      srapsEndpointId: { [Op.ne]: null },
      [Op.or]: [{ removedAt: { [Op.ne]: null } }, { provisioningState: 'wiped' }],
    },
    attributes: ['id'],
    limit: 200,
  });
  let released = 0;
  let tried = 0;
  for (const device of devices) {
    tried += 1;
    const answer = await releaseRedirect(device.id);
    if (answer && !answer.bound) released += 1;
    // The service is down: the rest would each wait for the same timeout. Tomorrow's run takes them.
    if (answer?.error === 'unreachable') break;
  }
  return { tried, released };
}

/**
 * Run the sweep once a day. Started by the server only.
 * @returns {() => void} stop
 */
export function startRedirectSweep({ intervalMs = 24 * 60 * 60 * 1000, log = logger, databaseStarted = Promise.resolve() } = {}) {
  let timer = null;
  let stopped = false;
  const run = () => sweepRedirects()
    .then((counts) => { if (counts.tried) log.info(counts, 'phone redirect: sweep of removed and wiped phones'); })
    .catch((err) => log.warn({ err: err?.message }, 'phone redirect: sweep failed; it runs again tomorrow'));
  databaseStarted.then(() => {
    if (stopped) return;
    run();
    timer = setInterval(run, intervalMs);
    if (timer.unref) timer.unref();
  });
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

/** What the vendor's redirect service holds for a desk phone, read from the service now. */
export async function redirectStatus(ctx, phoneId) {
  const phone = await Phone.findOne({ where: { id: phoneId, organisationId: ctx.organisation.id, removedAt: null } });
  if (!phone) throw new PbxError(404, 'not_found', 'Phone not found');
  const device = phone.deviceId ? await Device.findByPk(phone.deviceId) : null;
  if (phone.kind !== 'deskphone' || !device) throw new PbxError(409, 'not_a_desk_phone', 'Only a desk phone is provisioned.');
  const adapter = redirectFor(device.vendor);
  if (!adapter) return { redirect: null };
  const answer = await adapter.status(device.mac);
  if (!answer.ok) return { redirect: { service: adapter.service, error: answer.code } };
  return {
    redirect: {
      service: adapter.service,
      bound: answer.bound,
      // Bound by someone else in our own company, or left over, when it is not ours.
      ours: Boolean(device.srapsEndpointId),
      lastRequestAt: answer.lastRequestAt ?? null,
      firmware: answer.firmware ?? null,
    },
  };
}

/**
 * Give a desk phone a new settings address. The old address stops working at
 * once. The address is returned here and can not be read again.
 */
export async function provisionPhone(ctx, phoneId, { now = Date.now() } = {}) {
  const publicUrl = provisioningPublicUrl();
  if (!publicUrl) {
    throw new PbxError(503, 'provisioning_unavailable', 'Phone provisioning is not set up on this deployment (PROV_PUBLIC_URL).');
  }
  const result = await withDeskPhone(ctx, phoneId, async ({ phone, device, organisationId, transaction }) => {
    // A row can be older than the catalogue's word on its model.
    if (!phoneModel(device.vendor, device.reportedModel || device.model)?.supported) {
      throw new PbxError(409, 'model_not_supported', 'This phone\'s model is not supported, so it cannot be provisioned.', { field: 'model' });
    }
    const token = mintToken();
    const expiresAt = tokenExpiry(TOKEN_DAYS, now);
    // A wipe disabled the line accounts. Nothing knows their passwords, so they are safe to switch back on.
    // By each account's own status, not the device's state: lines can change while a phone is wiped.
    for (const account of await lineAccounts(phone.id, organisationId, transaction)) {
      if (account.status === 'disabled') await account.update({ status: 'active' }, { transaction });
    }
    await device.update({
      tokenHash: hashToken(token),
      tokenExpiresAt: expiresAt,
      tokenUsedAt: null,
      provisioningState: 'waiting',
      failure: null,
      fetchedVersion: null,
      configVersion: device.configVersion + 1,
    }, { transaction });
    return { deviceId: device.id, organisationId, phoneId: phone.id, provisioning: { url: settingServerUrl(publicUrl, token), expiresAt } };
  });
  // After the commit: the redirect service is another company's system.
  const redirect = await bindRedirect(result.deviceId, result.provisioning.url, now);
  if (redirect?.bound) result.provisioning.expiresAt = redirect.expiresAt;
  return {
    phone: await getPhone(result.organisationId, result.phoneId),
    provisioning: result.provisioning,
    redirect: redirect ? { service: redirect.service, bound: redirect.bound, ...(redirect.error ? { error: redirect.error } : {}) } : null,
  };
}

/**
 * Take the platform's settings away from a desk phone: its address stops
 * working and its line accounts can no longer register. The phone stays in
 * the list, and POST /phones/{phoneId}/provision brings it back.
 */
export async function wipePhone(ctx, phoneId) {
  const result = await withDeskPhone(ctx, phoneId, async ({ phone, device, organisationId, transaction }) => {
    for (const account of await lineAccounts(phone.id, organisationId, transaction)) {
      // A new hash of a password nobody has: what the phone holds stops working.
      await account.update({
        ha1: mintLineHash(account.username, account.registrar),
        previousHa1: null,
        previousHa1Until: null,
        status: 'disabled',
      }, { transaction });
    }
    await device.update({
      tokenHash: null,
      tokenExpiresAt: null,
      provisioningState: 'wiped',
      failure: null,
      fetchedVersion: null,
      configVersion: device.configVersion + 1,
    }, { transaction });
    return { deviceId: device.id, organisationId, phoneId: phone.id };
  });
  const redirect = await releaseRedirect(result.deviceId);
  return { phone: await getPhone(result.organisationId, result.phoneId), redirect };
}
