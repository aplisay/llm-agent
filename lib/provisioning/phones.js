/**
 * What the API does to a desk phone's provisioning: give it a settings
 * address, and wipe it.
 */
import { Device, Line, Phone, PhoneRegistration } from '../database.js';
import { phoneProvisioningReady } from '../capabilities.js';
import { PbxError } from '../pbx/errors.js';
import { mintLineHash } from '../pbx/line-password.js';
import { getPhone } from '../pbx/directory-views.js';
import { mintToken, hashToken, tokenExpiry, TOKEN_DAYS } from './token.js';
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

/**
 * Give a desk phone a new settings address. The old address stops working at
 * once. The address is returned here and can not be read again.
 */
export async function provisionPhone(ctx, phoneId, { now = Date.now() } = {}) {
  const publicUrl = provisioningPublicUrl();
  if (!publicUrl) {
    throw new PbxError(503, 'provisioning_unavailable', 'Phone provisioning is not set up on this deployment (PROV_PUBLIC_URL).');
  }
  return withDeskPhone(ctx, phoneId, async ({ phone, device, organisationId, transaction }) => {
    const token = mintToken();
    const expiresAt = tokenExpiry(TOKEN_DAYS, now);
    if (device.provisioningState === 'wiped') {
      // A wipe disabled the line accounts. Nothing knows their passwords, so they are safe to switch back on.
      for (const account of await lineAccounts(phone.id, organisationId, transaction)) {
        await account.update({ status: 'active' }, { transaction });
      }
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
    return {
      phone: await getPhone(organisationId, phone.id, { transaction }),
      provisioning: { url: settingServerUrl(publicUrl, token), expiresAt },
    };
  });
}

/**
 * Take the platform's settings away from a desk phone: its address stops
 * working and its line accounts can no longer register. The phone stays in
 * the list, and POST /phones/{phoneId}/provision brings it back.
 */
export async function wipePhone(ctx, phoneId) {
  return withDeskPhone(ctx, phoneId, async ({ phone, device, organisationId, transaction }) => {
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
      configVersion: device.configVersion + 1,
    }, { transaction });
    return { phone: await getPhone(organisationId, phone.id, { transaction }) };
  });
}
