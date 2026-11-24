/**
 * Who sees which calls (docs/phone-system.md, "Who sees calls").
 *
 * A principal with `call: readOthers` (owners, organisation admins, super
 * admins, support) sees every call in its tenancy scope, as before. Anyone
 * else sees agent calls as before, and a phone system call only when it
 * involves the directory person linked to their login:
 *
 *  - a call to an extension that person owns;
 *  - a call placed from one of their phones, or from a line of an extension
 *    they own;
 *  - a call whose answered leg rang for them. On a shared extension that is
 *    the member who answered, so a call nobody answered is not shown. Call
 *    control writes a leg's row when the network answers it and sends
 *    `answered` only when the leg ends, so a row with no `answered` counts as
 *    answered, unless it is a mobile still waiting for its key.
 *
 * A login with no linked person sees no phone system calls. A leg row is
 * shown when its call is. Recordings and transcripts follow the call.
 *
 * @module lib/call-visibility
 */
import { Op, literal } from 'sequelize';
import { Call, DirectoryEntry, Extension, PhonePerson, Line } from './database.js';
import { can } from './auth/permissions.js';
import { scopeWhereForUser } from './scope.js';
import { phoneSystemReady } from './capabilities.js';
import { PBX_PLATFORM } from './pbx/call-records.js';
import { notRedacted } from './redacted-calls.js';

const NOTHING = Object.freeze({ all: false, entryId: null, extensionIds: [], phoneIds: [], lineIds: [] });

/**
 * What the principal may see of the phone system's calls.
 *
 * @returns {Promise<{ all: true } | { all: false, entryId: string|null, extensionIds: string[], phoneIds: string[], lineIds: string[] }>}
 */
export async function callVisibility(user, {
  DirectoryEntry: Entries = DirectoryEntry, Extension: Extensions = Extension,
  PhonePerson: PhonePeople = PhonePerson, Line: Lines = Line,
} = {}) {
  if (can(user, 'call', 'readOthers')) return { all: true };
  if (!user?.id || !user.organisationId || !phoneSystemReady()) return NOTHING;
  const { organisationId } = user;
  const entry = await Entries.findOne({
    where: { organisationId, loginUserId: user.id, deletedAt: null },
    attributes: ['id'],
  });
  if (!entry) return NOTHING;
  // Removed extensions count until the daily purge deletes them, 30 days after removal.
  const extensionIds = (await Extensions.findAll({ where: { organisationId, entryId: entry.id }, attributes: ['id'] }))
    .map((row) => row.id);
  const phoneIds = (await PhonePeople.findAll({ where: { organisationId, entryId: entry.id }, attributes: ['phoneId'] }))
    .map((row) => row.phoneId);
  const lineIds = extensionIds.length
    ? (await Lines.findAll({ where: { organisationId, extensionId: extensionIds }, attributes: ['id'] })).map((row) => row.id)
    : [];
  return { all: false, entryId: entry.id, extensionIds, phoneIds, lineIds };
}

/**
 * The where condition that keeps the calls a visibility allows, for a query
 * on the Call model under `alias`. Null when it allows every call.
 */
export function visibilityCondition(visibility, { alias = 'Call', sequelize = Call.sequelize } = {}) {
  if (!visibility || visibility.all) return null;
  const list = (ids) => ids.map((id) => sequelize.escape(String(id))).join(', ');
  const field = (name) => `r.metadata->'pbx'->>'${name}'`;
  const ways = [];
  if (visibility.extensionIds?.length) ways.push(`${field('extensionId')} IN (${list(visibility.extensionIds)})`);
  if (visibility.phoneIds?.length) ways.push(`${field('fromPhoneId')} IN (${list(visibility.phoneIds)})`);
  if (visibility.lineIds?.length) ways.push(`${field('fromLineId')} IN (${list(visibility.lineIds)})`);
  if (visibility.entryId) {
    const leg = (name) => `l.metadata->'pbx'->>'${name}'`;
    ways.push(`EXISTS (SELECT 1 FROM calls l WHERE l.parent_id = r.id AND l.platform = '${PBX_PLATFORM}'
      AND ${leg('entryId')} = ${sequelize.escape(String(visibility.entryId))}
      AND (${leg('answered')} = 'true' OR (${leg('answered')} IS NULL
        AND (${leg('keyToAnswer')} IS DISTINCT FROM 'true' OR ${leg('keyPressedAt')} IS NOT NULL))))`);
  }
  const own = ways.length
    ? `EXISTS (SELECT 1 FROM calls r WHERE r.id = COALESCE("${alias}"."parent_id", "${alias}"."id") AND (${ways.join(' OR ')}))`
    : 'FALSE';
  return literal(`("${alias}"."platform" IS DISTINCT FROM '${PBX_PLATFORM}' OR ${own})`);
}

/**
 * A where condition for rows that name a call in `column` (usage rows), that
 * leaves out the rows of phone system calls the principal may not see. Rows
 * with no call, and the rows of agent calls, are kept. Null when the principal
 * sees every call.
 */
export async function hiddenCallsExcluded(user, { column = '"UsageRecord"."call_id"', visibility, models } = {}) {
  const condition = visibilityCondition(visibility ?? await callVisibility(user, models), { alias: 'Call' });
  if (!condition) return null;
  return literal(`NOT EXISTS (SELECT 1 FROM calls "Call" WHERE "Call"."id" = ${column} AND NOT ${condition.val})`);
}

/** Add a visibility condition to a where clause on the Call model. */
export function withVisibility(where, visibility, options) {
  const condition = visibilityCondition(visibility, options);
  if (!condition) return where;
  return { [Op.and]: [where, condition] };
}

/**
 * The where clause for the calls a principal may see: its tenancy scope and
 * the visibility rule.
 */
export async function visibleCallsWhere(user, models) {
  return withVisibility(scopeWhereForUser(user), await callVisibility(user, models));
}

/**
 * The call a principal may see, by id, or null. For routes that read
 * something of a call (its transcript, its recording) by the call's id.
 */
export async function findVisibleCall(user, callId, { attributes, visibility, models } = {}) {
  const tenancy = user?.sql?.where ?? scopeWhereForUser(user);
  const where = withVisibility({ id: callId, ...tenancy, ...notRedacted() }, visibility ?? await callVisibility(user, models));
  return Call.findOne({ where, ...(attributes ? { attributes } : {}) });
}
