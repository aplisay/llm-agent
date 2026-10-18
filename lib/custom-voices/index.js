/**
 * Custom voices: create, list, read and delete an organisation's own voices,
 * and merge them into the model voice lists (docs/custom-voices.md).
 *
 * Every function here is scoped to one organisation. A voice is never visible
 * to, or usable by, another organisation.
 */
import { Agent, CustomVoice, Organisation, Op, databaseStarted, ownCustomVoiceForAgent } from '../database.js';
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
const GENDERS = ['male', 'female', 'neutral'];
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

/** The API view of a row. `voice` is the value an agent puts in `options.tts.voice`. */
export function customVoiceView(row) {
  const r = row?.get ? row.get({ plain: true }) : row;
  return {
    id: r.id,
    name: r.name,
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
  const used = await CustomVoice.count({ where: countedWhere({ organisationId }), transaction });
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
 * Create a custom voice for the caller's organisation on `modelName`.
 *
 * The checks, the quota and the 'creating' row happen before this returns. The
 * quota check and the row are written under one advisory lock, so two requests
 * cannot both take the last slot. The vendor call then runs in the background,
 * and the caller polls the voice until it is 'ready' or 'failed'.
 *
 * @returns {Promise<object>} the API view of the new voice, status 'creating'
 */
export async function createCustomVoice({ user, modelName, locale, body = {}, fetchImpl, log = defaultLogger }) {
  const organisationId = requireOrganisation(user);
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
  const prompt = cleanText(body.prompt, 'prompt', spec.promptMaxChars, { required: true });
  const scriptHint = cleanText(body.scriptHint, 'scriptHint', spec.scriptHintMaxChars);
  const gender = body.gender ?? null;
  if (gender !== null && !GENDERS.includes(gender)) {
    throw new CustomVoiceError(400, `gender must be one of ${GENDERS.join(', ')}`);
  }

  const sequelize = CustomVoice.sequelize;
  const row = await sequelize.transaction(async (transaction) => {
    // One lock for every create: it covers the organisation count and the
    // platform-wide count, and creates are rare enough not to queue.
    await sequelize.query("SELECT pg_advisory_xact_lock(hashtext('custom_voices:create'))", { transaction });
    const quota = await getCustomVoiceQuota(user, { transaction });
    if (quota.limit !== null && quota.used >= quota.limit) {
      throw new CustomVoiceError(409,
        `Custom voice quota reached (${quota.used} of ${quota.limit})`,
        { code: 'custom_voice_quota_exceeded', quota });
    }
    const platformLimit = platformLimitFor(vendor, method);
    if (platformLimit !== null) {
      const platformUsed = await CustomVoice.count({ where: countedWhere({ vendor, method }), transaction });
      if (platformUsed >= platformLimit) {
        throw new CustomVoiceError(503,
          `The platform has no ${driver.label} ${method} voice slots left`,
          { code: 'custom_voice_platform_limit' });
      }
    }
    return CustomVoice.create({
      organisationId,
      createdBy: user?.id ? String(user.id) : null,
      vendor,
      method,
      name,
      prompt,
      locale,
      gender,
      status: 'creating',
      vendorData: scriptHint ? { request: { scriptHint } } : null,
    }, { transaction });
  });

  startCreateJob(row, { spec, driver, scriptHint, fetchImpl, log });
  return customVoiceView(row);
}

/**
 * The organisation's voices, newest first. Deleted rows only when asked.
 *
 * @returns {Promise<object[]>}
 */
export async function listCustomVoices(user, { includeDeleted = false, modelName } = {}) {
  const organisationId = requireOrganisation(user);
  const where = { organisationId, ...(includeDeleted ? {} : { status: { [Op.ne]: 'deleted' } }) };
  const query = () => CustomVoice.findAll({ where, order: [['createdAt', 'DESC']] });
  let rows = await query();
  if (rows.some((r) => isStaleCreating(r)) && await reconcileCreatingVoices(rows)) rows = await query();
  return rows
    .filter((r) => !modelName || customVoiceSupportsModel(r, modelName))
    .map(customVoiceView);
}

async function findOwned(user, id) {
  const organisationId = requireOrganisation(user);
  // Not a UUID: treat as absent rather than let Postgres raise on the cast.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''))) return null;
  return CustomVoice.findOne({ where: { id, organisationId } });
}

/** One voice. A poll on a create that has gone quiet settles it from the vendor first. */
export async function getCustomVoice(user, id) {
  const row = await findOwned(user, id);
  if (!row) throw new CustomVoiceError(404, `Custom voice ${id} not found`);
  if (isStaleCreating(row) && await reconcileCreatingVoices([row])) await row.reload();
  return customVoiceView(row);
}

/**
 * Delete a voice at the vendor, when the vendor can, then mark it deleted. Refused
 * while an agent of the organisation still names it, unless `force`: those agents
 * then fall back to the model's default voice. If the vendor delete fails, the
 * voice is left as it was.
 */
export async function deleteCustomVoice(user, id, { force = false, fetchImpl } = {}) {
  const row = await findOwned(user, id);
  if (!row || row.status === 'deleted') throw new CustomVoiceError(404, `Custom voice ${id} not found`);
  if (row.status === 'creating') {
    throw new CustomVoiceError(409, 'This voice is still being created; try again when it is ready or has failed');
  }
  if (row.vendorVoiceId && !force) {
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
  const deleteVoice = driverFor(row.vendor)?.deleteVoice;
  let deletion = null;
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
  return customVoiceView(row);
}

/**
 * Catalogue rows for the organisation's ready voices on `modelName`, grouped by
 * the vendor key the model's voice tree uses. A voice is listed at its own
 * locale, and at every locale when its locale is 'any'; asking for 'any' lists
 * them all.
 *
 * @returns {Promise<Record<string, object[]>>}
 */
export async function customVoiceCatalogueRows(user, modelName, { locale } = {}) {
  if (!user?.organisationId) return {};
  const rows = await CustomVoice.findAll({
    where: { organisationId: String(user.organisationId), status: 'ready', vendorVoiceId: { [Op.ne]: null } },
    order: [['createdAt', 'ASC']],
  });
  const out = {};
  for (const r of rows) {
    if (!customVoiceSupportsModel(r, modelName)) continue;
    if (locale && locale !== 'any' && r.locale !== 'any' && r.locale !== locale) continue;
    const key = driverFor(r.vendor)?.catalogueVendor || r.vendor;
    (out[key] ||= []).push({
      name: r.vendorVoiceId,
      description: `${r.name} (custom voice): ${r.prompt || ''}`.trim(),
      ...(r.gender ? { gender: r.gender } : {}),
      ...(r.locale !== 'any' ? { locale: r.locale } : {}),
      custom: true,
      customVoiceId: r.id,
      label: r.name,
    });
  }
  return out;
}

/**
 * What a worker needs to speak with the agent's custom voice: the vendor id and,
 * for a prompt voice, the prompt (GPT-Live wants it in the session instructions).
 * Undefined when `options.tts.voice` is not one of the organisation's ready voices.
 */
export async function customVoiceForAgent(agent) {
  const row = await ownCustomVoiceForAgent(agent);
  if (!row) return undefined;
  return {
    id: row.id,
    vendor: row.vendor,
    method: row.method,
    voice: row.vendorVoiceId,
    name: row.name,
    prompt: row.prompt,
    locale: row.locale,
  };
}

/** The locales of the organisation's ready voices on `modelName`. */
export async function customVoiceLocales(user, modelName) {
  const byVendor = await customVoiceCatalogueRows(user, modelName);
  const set = new Set();
  for (const rows of Object.values(byVendor)) for (const r of rows) set.add(r.locale || 'any');
  return [...set];
}
