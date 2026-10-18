/**
 * Custom voices: create, list, read and delete an organisation's own voices,
 * and merge them into the model voice lists (docs/custom-voices.md).
 *
 * Every function here is scoped to one organisation. A voice is never visible
 * to, or usable by, another organisation.
 */
import { Agent, CustomVoice, Organisation, Op, ownCustomVoiceForAgent } from '../database.js';
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

/**
 * Create a custom voice for the caller's organisation on `modelName`.
 *
 * The quota check and the 'creating' row are written under one advisory lock,
 * so two requests cannot both take the last slot. The vendor call runs after
 * that transaction commits, so no database connection waits on the vendor.
 *
 * @returns {Promise<object>} the API view of the new voice
 */
export async function createCustomVoice({ user, modelName, locale, body = {}, fetchImpl }) {
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
    }, { transaction });
  });

  let created;
  try {
    created = await spec.create({ name, prompt, scriptHint, ...(fetchImpl ? { fetchImpl } : {}) });
  }
  catch (err) {
    await row.update({ status: 'failed', error: err.message });
    throw new CustomVoiceError(err.statusCode || 502, err.message, { code: 'vendor_error', voice: customVoiceView(row) });
  }
  await row.update({
    status: 'ready',
    vendorVoiceId: created.vendorVoiceId,
    vendorData: { ...created.vendorData, ...(scriptHint ? { scriptHint } : {}) },
  });
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
  const rows = await CustomVoice.findAll({ where, order: [['createdAt', 'DESC']] });
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

export async function getCustomVoice(user, id) {
  const row = await findOwned(user, id);
  if (!row) throw new CustomVoiceError(404, `Custom voice ${id} not found`);
  return customVoiceView(row);
}

/**
 * Mark a voice deleted. Refused while an agent of the organisation still names
 * it, unless `force`: those agents then fall back to the model's default voice.
 */
export async function deleteCustomVoice(user, id, { force = false } = {}) {
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
  await row.update({ status: 'deleted', deletedAt: new Date() });
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
