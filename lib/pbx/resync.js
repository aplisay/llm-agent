/**
 * The desk phones that call control should tell to fetch their settings.
 *
 * Call control asks for them (POST /api/agent-db/pbx/resync/claim). The API
 * server never calls out. A phone is due when its settings changed after it
 * last fetched (state `updating`). Taking a phone writes the ask on its device
 * row, guarded, so each ask is given to one caller only. Nothing reports that
 * the phone was told: the proof is its next fetch, which the provisioning
 * service records. Until then the phone is due again after a wait
 * (lib/pbx/resync-rules.js).
 */
import { Op, literal } from 'sequelize';
import { Device, Line, Phone, PhoneRegistration } from '../database.js';
import defaultLogger from '../logger.js';
import {
  resyncDue, RESYNC_WAITS_MS, RESYNC_MAX_ASKS, RESYNC_MIN_GAP_MS, RESYNC_BATCH, RESYNC_STATES,
  RESYNC_HOLD_POLL_MS, RESYNC_MAX_HELD,
} from './resync-rules.js';

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

/** The rule of resyncDue as a query, so the limit counts due phones only. */
function dueWhere(now) {
  const before = (ms) => ({ [Op.lte]: new Date(now - ms) });
  return {
    [Op.or]: [
      { resyncRequestedAt: null },
      { [Op.and]: [literal('"resync_version" IS DISTINCT FROM "config_version"'), { resyncRequestedAt: before(RESYNC_MIN_GAP_MS) }] },
      {
        [Op.and]: [
          literal('"resync_version" = "config_version"'),
          {
            [Op.or]: [
              { resyncAttempts: { [Op.or]: [null, 0] }, resyncRequestedAt: before(RESYNC_MIN_GAP_MS) },
              ...RESYNC_WAITS_MS.map((wait, i) => ({ resyncAttempts: i + 1, resyncRequestedAt: before(wait) })),
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Take the phones that should be asked now, and record the ask on each.
 * @returns {Promise<object[]>} what call control is given for each phone
 */
export async function claimDueResyncs({ organisationId, limit = RESYNC_BATCH, now = Date.now(), log = defaultLogger } = {}) {
  if (limit < 1) return [];
  const candidates = await Device.findAll({
    where: {
      ...(organisationId ? { organisationId } : {}),
      removedAt: null,
      provisioningState: 'updating',
      [Op.and]: [literal('"fetched_version" < "config_version"'), dueWhere(now)],
    },
    // Never asked first, then the longest wait.
    order: [[literal('"resync_requested_at"'), 'ASC NULLS FIRST']],
    limit,
  });
  const phones = [];
  for (const device of candidates) {
    const { due, attempts } = resyncDue(device, now);
    if (!due) continue;
    const phone = await Phone.findOne({ where: { deviceId: device.id, removedAt: null }, attributes: ['id'] });
    const lines = phone ? await lineNames(phone.id, device.organisationId) : [];
    const attempt = attempts + 1;
    // The guard on the old values gives this ask to one caller only.
    const [claimed] = await Device.update({
      resyncVersion: device.configVersion,
      resyncRequestedAt: new Date(now),
      resyncAttempts: attempt,
      resyncState: lines.length ? 'taken' : 'no_lines',
    }, {
      where: {
        id: device.id,
        configVersion: device.configVersion,
        provisioningState: 'updating',
        resyncVersion: device.resyncVersion ?? null,
        resyncAttempts: device.resyncAttempts ?? null,
      },
    });
    if (!claimed) continue;
    if (attempt >= RESYNC_MAX_ASKS) {
      log.info({ deviceId: device.id, organisationId: device.organisationId, configVersion: device.configVersion },
        'phone resync: last ask for this version of the settings');
    }
    if (!lines.length) continue;
    phones.push({
      deviceId: device.id,
      phoneId: phone.id,
      organisationId: device.organisationId,
      configVersion: device.configVersion,
      attempt,
      action: 'check-sync',
      lines,
    });
  }
  return phones;
}

/**
 * Keep what call control says became of asks it took earlier. A report is
 * kept only while the row still holds that same ask.
 * @returns {Promise<number>} how many were kept
 */
export async function recordResyncResults(results = []) {
  let kept = 0;
  for (const result of results) {
    if (!RESYNC_STATES.includes(result?.state)) continue;
    const [count] = await Device.update({ resyncState: result.state }, {
      where: { id: result.deviceId, resyncVersion: result.configVersion, resyncAttempts: result.attempt },
    });
    kept += count;
  }
  return kept;
}

// Claim requests held open in this process, each with the function that ends its sleep early.
const held = new Set();

/** How many claim requests this process holds open now. */
export const heldClaims = () => held.size;

/**
 * After a directory write has committed: requests held open in this process
 * look again at once. One held by another process sees the change at its next
 * look. Reads no database.
 */
export function resyncAfterWrite() {
  for (const wake of held) wake();
}

/**
 * Take due phones, waiting up to `waitMs` for the first one.
 * @param {() => boolean} gone true once the caller has left: nothing is taken for a caller that cannot be answered
 */
export async function claimOrWait({ limit, waitMs = 0, gone = () => false, log = defaultLogger } = {}) {
  const until = Date.now() + waitMs;
  const mayHold = waitMs > 0 && held.size < RESYNC_MAX_HELD;
  for (;;) {
    if (gone()) return [];
    const phones = await claimDueResyncs({ limit, log });
    const left = until - Date.now();
    if (phones.length || !mayHold || left <= 0) return phones;
    let wake;
    const woken = new Promise((resolve) => { wake = resolve; });
    const timer = setTimeout(wake, Math.min(RESYNC_HOLD_POLL_MS, left));
    held.add(wake);
    try {
      await woken;
    } finally {
      clearTimeout(timer);
      held.delete(wake);
    }
  }
}
