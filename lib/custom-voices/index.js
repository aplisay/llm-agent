/**
 * Custom voices: create, list, read and delete an organisation's own voices,
 * and merge them into the model voice lists (docs/custom-voices.md).
 *
 * An organisation's own voice is never visible to, or usable by, another
 * organisation. A platform voice (`visibility: 'platform'`) is visible to and
 * usable by every organisation, and only a `voice:managePlatform` caller can
 * create, withdraw, release or delete one.
 */
import { Agent, CustomVoice, Organisation, Op, databaseStarted, usableCustomVoiceForAgent } from '../database.js';
import { can } from '../auth/permissions.js';
import defaultLogger from '../logger.js';
import {
  customVoiceSupportsModel,
  driverFor,
  methodFor,
  modelsForCustomVoice,
  platformLimitFor,
  vendorsForModel,
  vendorsHoldingDeletedVoices,
} from './drivers.js';

export const CUSTOM_VOICE_NAME_MAX_CHARS = 100;
export const CUSTOM_VOICE_DESCRIPTION_MAX_CHARS = 500;
const GENDERS = ['male', 'female', 'neutral'];
const VISIBILITIES = ['organisation', 'platform'];
const VENDOR_VOICE_ID_MAX_CHARS = 200;
const URL_MAX_CHARS = 2048;
// How many in-use agents a refused platform delete names.
const IN_USE_AGENTS_SHOWN = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// BCP 47 language tag, or 'any' for a voice that is not tied to a locale.
const LOCALE_RE = /^(any|[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*)$/;

export class CustomVoiceError extends Error {
  constructor(statusCode, message, extra = {}) {
    super(message);
    this.name = 'CustomVoiceError';
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

function requireOrganisation(user) {
  const organisationId = user?.organisationId;
  if (!organisationId) {
    throw new CustomVoiceError(400, 'Custom voices belong to an organisation; this principal has none');
  }
  return String(organisationId);
}

const canManagePlatform = (user) => can(user, 'voice', 'managePlatform');

function requireManagePlatform(user, what) {
  if (!canManagePlatform(user)) {
    throw new CustomVoiceError(403, `Only a platform administrator can ${what} platform voices`,
      { code: 'voice_platform_forbidden' });
  }
}

/** Where the vendor voice is managed: 'released' rows leave the vendor delete to another platform. */
function ownershipView(vendorData) {
  const released = vendorData?.ownership === 'released';
  return {
    state: released ? 'released' : 'owner',
    ...(vendorData?.adopted?.from ? { from: vendorData.adopted.from } : {}),
    ...(released && vendorData?.released?.to ? { to: vendorData.released.to } : {}),
  };
}

/**
 * The API view of a row. `voice` is the value an agent puts in `options.tts.voice`.
 * A `voice:managePlatform` caller also sees a platform voice's `ownership`.
 */
export function customVoiceView(row, { user } = {}) {
  const r = row?.get ? row.get({ plain: true }) : row;
  const platform = r.visibility === 'platform';
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    vendor: r.vendor,
    method: r.method,
    voice: r.vendorVoiceId ?? null,
    locale: r.locale,
    gender: r.gender ?? null,
    prompt: r.prompt ?? null,
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
    ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    models: modelsForCustomVoice(r),
    visibility: r.visibility || 'organisation',
    ...(r.withdrawnAt ? { withdrawnAt: r.withdrawnAt } : {}),
    ...(platform && user && canManagePlatform(user) ? { ownership: ownershipView(r.vendorData) } : {}),
    createdAt: r.createdAt,
    ...(r.deletedAt ? { deletedAt: r.deletedAt } : {}),
  };
}

/** Rows that use up quota: live ones, plus deleted ones the vendor still holds. */
function countedWhere(extra = {}) {
  const holding = vendorsHoldingDeletedVoices();
  return {
    ...extra,
    [Op.or]: [
      { status: { [Op.in]: ['creating', 'ready'] } },
      ...(holding.length ? [{ status: 'deleted', vendor: { [Op.in]: holding } }] : []),
    ],
  };
}

/**
 * The organisation's quota. `limit` null means no limit.
 *
 * @returns {Promise<{ limit: number | null, used: number, remaining: number | null }>}
 */
export async function getCustomVoiceQuota(user, { transaction } = {}) {
  const organisationId = requireOrganisation(user);
  const org = await Organisation.findByPk(organisationId, { attributes: ['id', 'customVoiceLimit'], transaction });
  if (!org) throw new CustomVoiceError(404, `Organisation ${organisationId} not found`);
  const limit = org.customVoiceLimit ?? null;
  const used = await CustomVoice.count({ where: countedWhere({ organisationId, visibility: 'organisation' }), transaction });
  return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
}

/**
 * The platform-wide count for a vendor method, over every organisation's voices
 * and the platform voices. `limit` null means no limit.
 *
 * @returns {Promise<{ limit: number | null, used: number, remaining: number | null }>}
 */
export async function getPlatformVoiceQuota(vendor = 'openai', method = 'prompt', { transaction } = {}) {
  const limit = platformLimitFor(vendor, method);
  const used = await CustomVoice.count({ where: countedWhere({ vendor, method }), transaction });
  return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
}

function cleanText(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new CustomVoiceError(400, `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new CustomVoiceError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new CustomVoiceError(400, `${field} must not be blank`);
    throw new CustomVoiceError(400, `${field} must not be blank when given`);
  }
  if (trimmed.length > max) throw new CustomVoiceError(400, `${field} must be at most ${max} characters`);
  return trimmed;
}

/** Like cleanText, but blank means none. */
function cleanDescription(value) {
  if (typeof value === 'string' && !value.trim()) return null;
  return cleanText(value, 'description', CUSTOM_VOICE_DESCRIPTION_MAX_CHARS);
}

/** Choose the vendor for a create request on `modelName`. */
function chooseVendor(modelName, method, requested) {
  const vendors = vendorsForModel(modelName, method);
  if (requested !== undefined && requested !== null) {
    const v = String(requested).toLowerCase();
    if (!vendors.includes(v)) {
      throw new CustomVoiceError(400,
        `Vendor ${requested} cannot create a ${method} voice for ${modelName}`
        + (vendors.length ? ` (can: ${vendors.join(', ')})` : ''));
    }
    return v;
  }
  if (vendors.length === 0) {
    throw new CustomVoiceError(400, `${modelName} does not support ${method} custom voices`);
  }
  if (vendors.length > 1) {
    throw new CustomVoiceError(400, `${modelName} can use custom voices from ${vendors.join(', ')}; name one in "vendor"`);
  }
  return vendors[0];
}

/** A row still 'creating' this long is looked for at the vendor: past the vendor call's own 60 s timeout. */
export const RECONCILE_AFTER_MS = 90_000;
/** Not at the vendor by this age: the create is not coming. */
export const INTERRUPTED_AFTER_MS = 180_000;

// Creates running in this process, by row id.
const jobs = new Map();

/** Resolves when this process's create for `id` has settled (at once when there is none). */
export function whenCustomVoiceSettled(id) {
  return jobs.get(id) ?? Promise.resolve();
}

function errorCodeFor(err) {
  if (err?.errorCode) return err.errorCode;
  if (err?.statusCode === 400) return 'rejected';
  if (err?.statusCode === 503) return 'vendor_unavailable';
  return 'vendor_error';
}

/**
 * Mark the row ready. A row that was deleted while the vendor was still making
 * the voice gets nothing; the voice is deleted at the vendor so it holds no slot.
 */
async function finishCreate(row, { vendorVoiceId, vendorData }, { log, fetchImpl } = {}) {
  const [updated] = await CustomVoice.update(
    {
      status: 'ready',
      vendorVoiceId,
      vendorData: { ...(row.vendorData || {}), ...vendorData },
      error: null,
      errorCode: null,
    },
    // 'failed' too: a create that outlived an 'interrupted' mark still made the voice.
    { where: { id: row.id, status: { [Op.in]: ['creating', 'failed'] } } },
  );
  if (updated) return true;
  const deleteVoice = driverFor(row.vendor)?.deleteVoice;
  if (deleteVoice) {
    try {
      await deleteVoice({ vendorVoiceId, ...(fetchImpl ? { fetchImpl } : {}) });
    }
    catch (err) {
      log.error({ err: err.message, customVoiceId: row.id, vendorVoiceId },
        'custom voice made after its row was deleted, and the vendor delete failed');
    }
  }
  return false;
}

async function failCreate(row, err) {
  await CustomVoice.update(
    { status: 'failed', error: err.message, errorCode: errorCodeFor(err) },
    { where: { id: row.id, status: 'creating' } },
  );
}

function startCreateJob(row, { spec, driver, scriptHint, fetchImpl, log }) {
  const job = (async () => {
    try {
      const created = await spec.create({
        name: driver.vendorName ? driver.vendorName(row.id) : row.name,
        prompt: row.prompt,
        scriptHint,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      await finishCreate(row, created, { log, fetchImpl });
    }
    catch (err) {
      if (err?.unknownOutcome) {
        // The vendor may have made it: leave it 'creating' for the list check in reconcileCreatingVoices.
        log.warn({ err: err.message, customVoiceId: row.id, vendor: row.vendor }, 'custom voice create got no answer');
        return;
      }
      log.warn({ err: err.message, customVoiceId: row.id, vendor: row.vendor }, 'custom voice create failed');
      await failCreate(row, err).catch((e) => log.error({ err: e.message, customVoiceId: row.id }, 'recording a failed custom voice'));
    }
    finally {
      jobs.delete(row.id);
    }
  })();
  jobs.set(row.id, job);
  return job;
}

/**
 * Settle creates the server lost track of: a restart, or work that stalled after
 * the response went (Cloud Run may throttle CPU then). The voice is looked for at
 * the vendor by the name it was given there. Creates this process is still
 * running are left alone.
 */
export async function reconcileCreatingVoices(rows, { now = Date.now(), log = defaultLogger, fetchImpl } = {}) {
  let settled = 0;
  for (const row of rows) {
    if (row.status !== 'creating' || jobs.has(row.id)) continue;
    const age = now - new Date(row.createdAt).getTime();
    if (age < RECONCILE_AFTER_MS) continue;
    const driver = driverFor(row.vendor);
    let found = null;
    if (driver?.findVoice && driver.vendorName) {
      try {
        found = await driver.findVoice({ name: driver.vendorName(row.id), ...(fetchImpl ? { fetchImpl } : {}) });
      }
      catch (err) {
        log.warn({ err: err.message, customVoiceId: row.id }, 'could not look for an unfinished custom voice at the vendor');
        continue;
      }
    }
    if (found?.id) {
      await finishCreate(row, { vendorVoiceId: found.id, vendorData: { ...found, reconciled: true } }, { log, fetchImpl });
      settled += 1;
    }
    else if (age >= INTERRUPTED_AFTER_MS) {
      const err = new Error('Creating the voice was interrupted. Delete it and try again.');
      err.errorCode = 'interrupted';
      await failCreate(row, err);
      settled += 1;
    }
  }
  return settled;
}

const isStaleCreating = (row, now = Date.now()) =>
  row.status === 'creating' && now - new Date(row.createdAt).getTime() >= RECONCILE_AFTER_MS;

/** One pass over every organisation's unfinished creates. */
export async function sweepCreatingVoices({ now = Date.now(), log = defaultLogger, fetchImpl } = {}) {
  try {
    const rows = await CustomVoice.findAll({
      where: { status: 'creating', createdAt: { [Op.lt]: new Date(now - RECONCILE_AFTER_MS) } },
      order: [['createdAt', 'ASC']],
      limit: 50,
    });
    return await reconcileCreatingVoices(rows, { now, log, fetchImpl });
  }
  catch (err) {
    log.error({ err: err.message }, 'custom voice sweep failed');
    return 0;
  }
}

/**
 * Run {@link sweepCreatingVoices} on a timer. Started by the server only
 * (index.mjs), never on import, for the same reason as the chat session reaper.
 *
 * @returns {() => void} stop
 */
export function startCustomVoiceSweeper({ intervalMs = 60_000, log = defaultLogger } = {}) {
  let timer = null;
  let stopped = false;
  databaseStarted.then(() => {
    if (stopped) return;
    sweepCreatingVoices({ log });
    timer = setInterval(() => sweepCreatingVoices({ log }), intervalMs);
    if (timer.unref) timer.unref();
  });
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

/**
 * Create a custom voice for the caller's organisation on `modelName`, or, with
 * `body.visibility` 'platform', a platform voice every organisation can use.
 *
 * The checks, the quota and the 'creating' row happen before this returns. The
 * quota check and the row are written under one advisory lock, so two requests
 * cannot both take the last slot. The vendor call then runs in the background,
 * and the caller polls the voice until it is 'ready' or 'failed'.
 *
 * A platform voice counts against no organisation's quota, only the platform
 * cap. With `body.vendorVoiceId` it registers a voice the vendor key can already
 * use: the row is 'ready' at once and nothing is created at the vendor.
 *
 * @returns {Promise<object>} the API view of the new voice, status 'creating' (or 'ready' for a vendorVoiceId)
 */
export async function createCustomVoice({ user, modelName, locale, body = {}, fetchImpl, log = defaultLogger }) {
  const organisationId = requireOrganisation(user);
  const visibility = body.visibility ?? 'organisation';
  if (!VISIBILITIES.includes(visibility)) {
    throw new CustomVoiceError(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);
  }
  const platform = visibility === 'platform';
  if (platform) requireManagePlatform(user, 'create');
  if (!platform && body.vendorVoiceId !== undefined) {
    throw new CustomVoiceError(400, 'vendorVoiceId is only accepted with visibility "platform"');
  }
  if (!LOCALE_RE.test(String(locale || ''))) {
    throw new CustomVoiceError(400, `Invalid locale ${locale}: use a BCP 47 tag such as en-GB, or "any"`);
  }
  const method = body.method ?? 'prompt';
  if (method === 'recording') {
    throw new CustomVoiceError(501, 'Voices from a recording are not available yet; see docs/custom-voices.md');
  }
  if (method !== 'prompt') {
    throw new CustomVoiceError(400, `Unknown method ${method}: use "prompt"`);
  }
  const vendor = chooseVendor(modelName, method, body.vendor);
  const driver = driverFor(vendor);
  const spec = methodFor(vendor, method);
  if (!driver.configured()) {
    throw new CustomVoiceError(503, `${driver.label} custom voices are not configured on this platform`);
  }

  const name = cleanText(body.name, 'name', CUSTOM_VOICE_NAME_MAX_CHARS, { required: true });
  const description = cleanDescription(body.description);
  const prompt = cleanText(body.prompt, 'prompt', spec.promptMaxChars, { required: true });
  const scriptHint = cleanText(body.scriptHint, 'scriptHint', spec.scriptHintMaxChars);
  const gender = body.gender ?? null;
  if (gender !== null && !GENDERS.includes(gender)) {
    throw new CustomVoiceError(400, `gender must be one of ${GENDERS.join(', ')}`);
  }
  const vendorVoiceId = cleanText(body.vendorVoiceId, 'vendorVoiceId', VENDOR_VOICE_ID_MAX_CHARS);
  const adoptedFrom = vendorVoiceId ? cleanText(body.adoptedFrom, 'adoptedFrom', URL_MAX_CHARS) : null;
  let vendorVoice = null;
  if (vendorVoiceId) {
    if (!driver.findVoiceById) {
      throw new CustomVoiceError(400, `${driver.label} voices cannot be registered by vendorVoiceId`);
    }
    try {
      vendorVoice = await driver.findVoiceById({ vendorVoiceId, ...(fetchImpl ? { fetchImpl } : {}) });
    }
    catch (err) {
      throw new CustomVoiceError(err.statusCode || 502, err.message, { code: 'vendor_error' });
    }
    if (!vendorVoice) {
      throw new CustomVoiceError(400, `${driver.label} has no voice ${vendorVoiceId} that this platform can use`,
        { code: 'vendor_voice_not_found' });
    }
  }

  const sequelize = CustomVoice.sequelize;
  const row = await sequelize.transaction(async (transaction) => {
    // One lock for every create: it covers the organisation count and the
    // platform-wide count, and creates are rare enough not to queue.
    await sequelize.query("SELECT pg_advisory_xact_lock(hashtext('custom_voices:create'))", { transaction });
    if (vendorVoiceId) {
      // Any row, deleted ones too: the unique index on (vendor, vendor_voice_id) covers them all.
      const existing = await CustomVoice.findOne({ where: { vendor, vendorVoiceId }, attributes: ['id', 'status'], transaction });
      if (existing) {
        throw new CustomVoiceError(409,
          existing.status === 'deleted'
            ? `Voice ${vendorVoiceId} was registered here before and deleted; it cannot be registered again`
            : `Voice ${vendorVoiceId} is already registered here`,
          { code: 'custom_voice_exists', customVoiceId: existing.id });
      }
    }
    if (!platform) {
      const quota = await getCustomVoiceQuota(user, { transaction });
      if (quota.limit !== null && quota.used >= quota.limit) {
        throw new CustomVoiceError(409,
          `Custom voice quota reached (${quota.used} of ${quota.limit})`,
          { code: 'custom_voice_quota_exceeded', quota });
      }
    }
    const platformQuota = await getPlatformVoiceQuota(vendor, method, { transaction });
    if (platformQuota.limit !== null && platformQuota.used >= platformQuota.limit) {
      throw new CustomVoiceError(503,
        `The platform has no ${driver.label} ${method} voice slots left`,
        { code: 'custom_voice_platform_limit' });
    }
    const request = scriptHint ? { request: { scriptHint } } : {};
    return CustomVoice.create({
      organisationId,
      createdBy: user?.id ? String(user.id) : null,
      vendor,
      method,
      name,
      description,
      prompt,
      locale,
      gender,
      visibility,
      ...(vendorVoiceId
        ? {
          status: 'ready',
          vendorVoiceId,
          vendorData: {
            ...vendorVoice,
            ...request,
            ownership: 'owner',
            adopted: { from: adoptedFrom, at: new Date().toISOString() },
          },
        }
        : { status: 'creating', vendorData: scriptHint ? request : null }),
    }, { transaction });
  });

  if (!vendorVoiceId) startCreateJob(row, { spec, driver, scriptHint, fetchImpl, log });
  return customVoiceView(row, { user });
}

/**
 * How many agents, and in how many organisations, name each of `vendorVoiceIds`.
 *
 * @returns {Promise<Map<string, { agents: number, organisations: number }>>}
 */
async function inUseCounts(vendorVoiceIds) {
  const out = new Map();
  if (!vendorVoiceIds.length) return out;
  const [rows] = await Agent.sequelize.query(
    `SELECT options->'tts'->>'voice' AS voice, COUNT(*)::int AS agents, COUNT(DISTINCT organisation_id)::int AS organisations
       FROM "${Agent.getTableName()}"
      WHERE options->'tts'->>'voice' IN (:ids)
      GROUP BY 1`,
    { replacements: { ids: vendorVoiceIds } },
  );
  for (const r of rows) out.set(r.voice, { agents: r.agents, organisations: r.organisations });
  return out;
}

/**
 * The organisation's own voices, newest first; or, with `visibility` 'platform',
 * every platform voice, withdrawn ones included. Deleted rows only when asked. A
 * `voice:managePlatform` caller also gets each platform voice's `inUse` counts
 * and `scriptHint`.
 *
 * @returns {Promise<object[]>}
 */
export async function listCustomVoices(user, { includeDeleted = false, modelName, visibility = 'organisation' } = {}) {
  if (!VISIBILITIES.includes(visibility)) {
    throw new CustomVoiceError(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);
  }
  const platform = visibility === 'platform';
  const where = {
    ...(platform ? { visibility } : { organisationId: requireOrganisation(user), visibility }),
    ...(includeDeleted ? {} : { status: { [Op.ne]: 'deleted' } }),
  };
  const query = () => CustomVoice.findAll({ where, order: [['createdAt', 'DESC']] });
  let rows = await query();
  if (rows.some((r) => isStaleCreating(r)) && await reconcileCreatingVoices(rows)) rows = await query();
  rows = rows.filter((r) => !modelName || customVoiceSupportsModel(r, modelName));
  if (!platform || !canManagePlatform(user)) return rows.map((r) => customVoiceView(r, { user }));
  const counts = await inUseCounts(rows.map((r) => r.vendorVoiceId).filter(Boolean));
  return rows.map((r) => ({
    ...customVoiceView(r, { user }),
    inUse: counts.get(r.vendorVoiceId) || { agents: 0, organisations: 0 },
    scriptHint: r.vendorData?.request?.scriptHint ?? null,
  }));
}

/** A voice the caller can see: one of its organisation's own, or a platform voice. */
async function findVisible(user, id) {
  // Not a UUID: treat as absent rather than let Postgres raise on the cast.
  if (!UUID_RE.test(String(id || ''))) return null;
  const organisationId = user?.organisationId ? String(user.organisationId) : null;
  return CustomVoice.findOne({
    where: {
      id,
      [Op.or]: [...(organisationId ? [{ organisationId }] : []), { visibility: 'platform' }],
    },
  });
}

/** One voice. A poll on a create that has gone quiet settles it from the vendor first. */
export async function getCustomVoice(user, id) {
  const row = await findVisible(user, id);
  if (!row) throw new CustomVoiceError(404, `Custom voice ${id} not found`);
  if (isStaleCreating(row) && await reconcileCreatingVoices([row])) await row.reload();
  return customVoiceView(row, { user });
}

/** Agents in any organisation that name a platform voice, with their organisation's name. */
async function platformVoiceAgents(vendorVoiceId) {
  const where = { options: { tts: { voice: vendorVoiceId } } };
  const [total, agents] = await Promise.all([
    Agent.count({ where }),
    Agent.findAll({
      where,
      attributes: ['id', 'name', 'organisationId'],
      include: [{ model: Organisation, attributes: ['name'] }],
      order: [['createdAt', 'ASC']],
      limit: IN_USE_AGENTS_SHOWN,
    }),
  ]);
  return {
    total,
    agents: agents.map((a) => ({
      id: a.id, name: a.name, organisationId: a.organisationId, organisationName: a.Organisation?.name ?? null,
    })),
  };
}

/**
 * Delete a voice at the vendor, when the vendor can, then mark it deleted. Refused
 * while an agent of the organisation still names it, unless `force`: those agents
 * then fall back to the model's default voice. If the vendor delete fails, the
 * voice is left as it was.
 *
 * A platform voice needs `voice:managePlatform`, and is refused while any agent in
 * any organisation names it, whatever `force` says. A released platform voice is
 * marked deleted here only: the vendor delete is left to where it was released to.
 */
export async function deleteCustomVoice(user, id, { force = false, fetchImpl } = {}) {
  const row = await findVisible(user, id);
  if (!row || row.status === 'deleted') throw new CustomVoiceError(404, `Custom voice ${id} not found`);
  const platform = row.visibility === 'platform';
  if (platform) requireManagePlatform(user, 'delete');
  if (row.status === 'creating') {
    throw new CustomVoiceError(409, 'This voice is still being created; try again when it is ready or has failed');
  }
  if (row.vendorVoiceId && platform) {
    const { total, agents } = await platformVoiceAgents(row.vendorVoiceId);
    if (total) {
      throw new CustomVoiceError(409,
        `Platform voice is used by ${total} agent(s); every agent must stop using it before it can be deleted`,
        { code: 'custom_voice_in_use', agents, total });
    }
  }
  else if (row.vendorVoiceId && !force) {
    const agents = await Agent.findAll({
      where: { organisationId: row.organisationId, options: { tts: { voice: row.vendorVoiceId } } },
      attributes: ['id', 'name'],
    });
    if (agents.length) {
      throw new CustomVoiceError(409,
        `Custom voice is used by ${agents.length} agent(s); change their voice first, or delete with force=true`,
        { code: 'custom_voice_in_use', agents: agents.map((a) => ({ id: a.id, name: a.name })) });
    }
  }
  const released = row.vendorData?.ownership === 'released';
  const deleteVoice = released ? null : driverFor(row.vendor)?.deleteVoice;
  let deletion = released ? { at: new Date().toISOString(), local: true } : null;
  if (row.vendorVoiceId && deleteVoice) {
    try {
      const result = await deleteVoice({ vendorVoiceId: row.vendorVoiceId, ...(fetchImpl ? { fetchImpl } : {}) });
      deletion = { at: new Date().toISOString(), alreadyGone: result.alreadyGone, response: result.vendorData };
    }
    catch (err) {
      throw new CustomVoiceError(err.statusCode || 502, err.message, { code: 'vendor_error' });
    }
  }
  await row.update({
    status: 'deleted',
    deletedAt: new Date(),
    ...(deletion ? { vendorData: { ...(row.vendorData || {}), deletion } } : {}),
  });
  return customVoiceView(row, { user });
}

/**
 * Change a voice. `description` (a string, or null to clear it) is the search text
 * shown in voice lists, apart from the prompt the voice was made from; it can be
 * changed on the organisation's own voices and, by a platform administrator, on
 * platform voices. The rest are for platform voices only. `withdrawn` true leaves
 * the voice out of every voice list (agents that have it keep it), false lists it
 * again. `release: { to }` hands the vendor delete to `to`: a later delete here is
 * local only. A release is one way, and a second one changes nothing. There is no
 * rename.
 */
export async function patchCustomVoice(user, id, body = {}) {
  const keys = Object.keys(body || {});
  const unknown = keys.filter((k) => !['description', 'withdrawn', 'release'].includes(k));
  if (unknown.length) {
    throw new CustomVoiceError(400, `Only description, withdrawn and release can be changed (got ${unknown.join(', ')})`);
  }
  if (!keys.length) throw new CustomVoiceError(400, 'Send description, withdrawn or release');
  const { description, withdrawn, release } = body;
  const newDescription = description === undefined ? undefined : cleanDescription(description);
  if (withdrawn !== undefined && typeof withdrawn !== 'boolean') throw new CustomVoiceError(400, 'withdrawn must be true or false');
  let releaseTo = null;
  if (release !== undefined) {
    if (!release || typeof release !== 'object' || Array.isArray(release)) {
      throw new CustomVoiceError(400, 'release must be an object with "to"');
    }
    const extra = Object.keys(release).filter((k) => k !== 'to');
    if (extra.length) throw new CustomVoiceError(400, `release takes only "to" (got ${extra.join(', ')})`);
    releaseTo = cleanText(release.to, 'release.to', URL_MAX_CHARS, { required: true });
  }

  const row = await findVisible(user, id);
  if (!row || row.status === 'deleted') throw new CustomVoiceError(404, `Custom voice ${id} not found`);
  if (row.visibility === 'platform') requireManagePlatform(user, 'change');
  else if (withdrawn !== undefined || release !== undefined) {
    throw new CustomVoiceError(400, 'Only a platform voice can be withdrawn or released');
  }
  const changes = {};
  if (description !== undefined && newDescription !== (row.description ?? null)) changes.description = newDescription;
  if (withdrawn === true && !row.withdrawnAt) changes.withdrawnAt = new Date();
  if (withdrawn === false && row.withdrawnAt) changes.withdrawnAt = null;
  if (releaseTo && row.vendorData?.ownership !== 'released') {
    if (row.status !== 'ready') throw new CustomVoiceError(409, 'Only a ready voice can be released');
    changes.vendorData = {
      ...(row.vendorData || {}),
      ownership: 'released',
      released: { to: releaseTo, at: new Date().toISOString() },
    };
  }
  if (Object.keys(changes).length) await row.update(changes);
  return customVoiceView(row, { user });
}

/**
 * Catalogue rows for the ready voices on `modelName` the caller can use, grouped
 * by the vendor key the model's voice tree uses: the organisation's own first,
 * then the platform voices that are not withdrawn (`platform: true`). With no
 * organisation, the platform voices only. A voice is listed at its own locale,
 * and at every locale when its locale is 'any'; asking for 'any' lists them all.
 *
 * @returns {Promise<Record<string, object[]>>}
 */
export async function customVoiceCatalogueRows(user, modelName, { locale } = {}) {
  const organisationId = user?.organisationId ? String(user.organisationId) : null;
  const rows = await CustomVoice.findAll({
    where: {
      status: 'ready',
      vendorVoiceId: { [Op.ne]: null },
      [Op.or]: [
        ...(organisationId ? [{ organisationId, visibility: 'organisation' }] : []),
        { visibility: 'platform', withdrawnAt: null },
      ],
    },
    order: [['createdAt', 'ASC']],
  });
  const ordered = [
    ...rows.filter((r) => r.visibility !== 'platform'),
    ...rows.filter((r) => r.visibility === 'platform'),
  ];
  const out = {};
  for (const r of ordered) {
    if (!customVoiceSupportsModel(r, modelName)) continue;
    if (locale && locale !== 'any' && r.locale !== 'any' && r.locale !== locale) continue;
    const platform = r.visibility === 'platform';
    const key = driverFor(r.vendor)?.catalogueVendor || r.vendor;
    // The description leads so its keywords survive the builder's 100-character trim. Search reads
    // this text, not the flags, so a platform voice says "custom" too.
    const text = [r.description, r.prompt].filter(Boolean).join(' ');
    (out[key] ||= []).push({
      name: r.vendorVoiceId,
      description: `${r.name} (${platform ? 'custom platform' : 'custom'} voice): ${text}`.trim(),
      ...(r.gender ? { gender: r.gender } : {}),
      ...(r.locale !== 'any' ? { locale: r.locale } : {}),
      custom: true,
      ...(platform ? { platform: true } : {}),
      customVoiceId: r.id,
      label: r.name,
    });
  }
  return out;
}

/**
 * What a worker needs to speak with the agent's custom voice: the vendor id and,
 * for a prompt voice, the prompt (GPT-Live wants it in the session instructions).
 * Undefined when `options.tts.voice` is not a ready voice the agent may use.
 */
export async function customVoiceForAgent(agent) {
  const row = await usableCustomVoiceForAgent(agent);
  if (!row) return undefined;
  return {
    id: row.id,
    vendor: row.vendor,
    method: row.method,
    voice: row.vendorVoiceId,
    name: row.name,
    prompt: row.prompt,
    locale: row.locale,
    visibility: row.visibility,
  };
}

/** The locales of the ready voices on `modelName` the caller can use. */
export async function customVoiceLocales(user, modelName) {
  const byVendor = await customVoiceCatalogueRows(user, modelName);
  const set = new Set();
  for (const rows of Object.values(byVendor)) for (const r of rows) set.add(r.locale || 'any');
  return [...set];
}

/**
 * The ready voices on `modelName` the caller can use, as a vendor → locale → rows
 * tree, the shape the list_voices search runs over.
 *
 * @returns {Promise<Record<string, Record<string, object[]>>>}
 */
export async function customVoiceTree(user, modelName) {
  const tree = {};
  for (const [vendor, rows] of Object.entries(await customVoiceCatalogueRows(user, modelName))) {
    for (const r of rows) ((tree[vendor] ||= {})[r.locale || 'any'] ||= []).push(r);
  }
  return tree;
}
