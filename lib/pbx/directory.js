/**
 * Writes to the directory: entries, extensions, members, phones and the
 * people a phone rings for.
 *
 * Every write runs in one transaction, under a lock for the organisation, and
 * ends by working out the lines of the organisation's phones again
 * (lib/pbx/reconcile.js). With `dryRun` the same code runs and the
 * transaction is rolled back, so the effect reported is the effect the real
 * write would have.
 *
 * A refusal is a PbxError (lib/pbx/errors.js).
 */
import { randomUUID } from 'node:crypto';
import {
  DirectoryEntry, Extension, ExtensionMember, Device, Phone, PhonePerson, PhoneNumber, PhoneRegistration, Trunk, User, Op,
} from '../database.js';
import { hasCapability, PHONE_SYSTEM_DISABLED } from '../capabilities.js';
import { normaliseEntryFields, toE164 } from '../directory/fields.js';
import { EXTENSION_TYPES, isReservedExtensionNumber } from '../database-models/extension.js';
import { PHONE_KINDS, PHONE_SHOWS } from '../database-models/phone.js';
import { PbxError } from './errors.js';
import { pbxRelease, releasedExtensionTypes, releasedPhoneKinds } from './release.js';
import { validateExtensionParams, destinationsIn, effectiveParams } from './extension-params.js';
import { phoneModel, normaliseMac, isSnomMac, phoneCapacity } from './phone-models.js';
import { RINGING_TYPES, maxPeople } from './lines.js';
import { restack, removeLinesOfPhone, effectOf } from './reconcile.js';
import { notADeviceLine } from './store.js';
import { plusE164 } from './numbers.js';
import { entryView, extensionView, phoneView, loadIndex } from './directory-views.js';

// Types whose calls ring their members' phones.
const MEMBER_TYPES = RINGING_TYPES;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITION_PARK = 1000;

const notFound = (what = 'Not found') => new PbxError(404, 'not_found', what);
const isId = (value) => typeof value === 'string' && UUID_RE.test(value);

function requireGate(ctx, field) {
  if (!hasCapability(ctx.organisation, 'phoneSystem')) {
    throw new PbxError(403, PHONE_SYSTEM_DISABLED.code, PHONE_SYSTEM_DISABLED.error, field ? { field } : {});
  }
}

const UNIQUE_INDEX_ERRORS = {
  extensions_org_number: [409, 'extension_number_taken', 'That extension number is already in use.', 'number'],
  extensions_entry: [409, 'entry_has_extension', 'This entry already has an extension.', 'entryId'],
  directory_entries_org_login: [409, 'login_already_linked', 'That login is already linked to another person.', 'loginUserId'],
  devices_mac_held: [409, 'phone_held_elsewhere', 'This phone is registered to another organisation. Contact support.', 'mac'],
  phones_org_number: [409, 'phone_in_directory', 'A phone with that number is already in your directory.', 'number'],
  extension_members_ext_entry: [409, 'already_member', 'That person is already a member.', 'entryId'],
};

function mapDatabaseError(err) {
  if (err instanceof PbxError) return err;
  if (err?.name === 'SequelizeUniqueConstraintError') {
    const text = `${err.parent?.constraint || ''} ${err.message || ''} ${JSON.stringify(err.fields || {})}`;
    for (const [indexName, [status, code, message, field]] of Object.entries(UNIQUE_INDEX_ERRORS)) {
      if (text.includes(indexName)) return new PbxError(status, code, message, { field });
    }
  }
  if (err?.name === 'SequelizeValidationError') {
    return new PbxError(400, 'invalid_request', err.errors?.[0]?.message || err.message);
  }
  return err;
}

/**
 * Run one write. `fn(state)` makes the changes and returns the route's result
 * (or a function that builds it once the lines are worked out). `state` holds
 * the transaction, the list of rows touched, and the cause recorded against
 * each phone whose keys change.
 */
async function runWrite(ctx, cause, fn) {
  const { sequelize } = Extension;
  const transaction = await sequelize.transaction();
  const state = { transaction, changes: [], relabelled: new Set(), cause, extraPhones: [], warnings: [] };
  try {
    // One directory write at a time for an organisation, so two admins' changes
    // cannot interleave their line working-out. Not the key the call numbering uses.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
      replacements: { key: `pbx-directory:${ctx.organisation.id}` },
      transaction,
    });
    let result = await fn(state);
    const worked = await restack({
      organisationId: ctx.organisation.id,
      transaction,
      dryRun: Boolean(ctx.dryRun),
      cause: state.cause,
      actor: ctx.actor,
      requestId: randomUUID(),
      relabelled: state.relabelled,
    });
    const effect = effectOf([...state.extraPhones, ...worked.phones], state.dependents ? { dependents: state.dependents } : {});
    if (state.warnings.length) effect.warnings = state.warnings;
    if (typeof result === 'function') result = await result(transaction);
    if (ctx.dryRun) {
      await transaction.rollback();
      return { dryRun: true, effect, changes: state.changes };
    }
    await transaction.commit();
    return { ...result, effect, changes: state.changes };
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw mapDatabaseError(err);
  }
}

const change = (state, target, id, op, before, after) => state.changes.push({ target, id, op, before, after });

// ---------------------------------------------------------------------------
// Loading rows for a write

async function liveEntry(ctx, entryId, transaction) {
  if (!isId(entryId)) return null;
  return DirectoryEntry.findOne({
    where: { id: entryId, organisationId: ctx.organisation.id, deletedAt: null },
    transaction,
  });
}

async function liveExtension(ctx, extensionId, transaction) {
  if (!isId(extensionId)) return null;
  const extension = await Extension.findOne({
    where: { id: extensionId, organisationId: ctx.organisation.id, deletedAt: null },
    transaction,
  });
  if (!extension) return null;
  // An extension whose entry was removed went with it.
  if (extension.entryId && !(await liveEntry(ctx, extension.entryId, transaction))) return null;
  return extension;
}

async function livePhone(ctx, phoneId, transaction) {
  if (!isId(phoneId)) return null;
  return Phone.findOne({ where: { id: phoneId, organisationId: ctx.organisation.id, removedAt: null }, transaction });
}

const extensionOfEntry = (ctx, entryId, transaction) => Extension.findOne({
  where: { entryId, organisationId: ctx.organisation.id, deletedAt: null },
  transaction,
});

async function liveIds(Model, ctx, transaction, liveWhere) {
  const rows = await Model.findAll({ where: { organisationId: ctx.organisation.id, ...liveWhere }, attributes: ['id'], transaction });
  return new Set(rows.map((row) => row.id));
}

/**
 * Write an order to a set of rows: the listed ids take positions 1..n, then
 * the rest of the set keep their order after them. Rows of removed people or
 * extensions stay in the set, so they must be given positions too. Two steps,
 * because the positions are unique.
 */
async function writeOrder(Model, field, rows, orderedIds, transaction) {
  const listed = orderedIds.map((id) => rows.find((row) => row.id === id)).filter(Boolean);
  const rest = rows.filter((row) => !orderedIds.includes(row.id)).sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0));
  const final = [...listed, ...rest];
  const moving = final.filter((row, i) => row[field] !== i + 1);
  for (const row of moving) await row.update({ [field]: POSITION_PARK + final.indexOf(row) + 1 }, { transaction });
  for (const row of moving) await row.update({ [field]: final.indexOf(row) + 1 }, { transaction });
}

/** Put a person's shared extensions in key order: live ones as listed, the rest after. */
async function writeKeyOrder(ctx, entryId, extensionIdsInOrder, transaction) {
  const rows = await ExtensionMember.findAll({
    where: { entryId, organisationId: ctx.organisation.id, keyPosition: { [Op.ne]: null } },
    transaction,
  });
  const ids = extensionIdsInOrder.map((extensionId) => rows.find((row) => row.extensionId === extensionId)?.id).filter(Boolean);
  await writeOrder(ExtensionMember, 'keyPosition', rows, ids, transaction);
}

/** The person's shared memberships of live extensions, in key order. */
async function sharedMemberships(ctx, entryId, transaction) {
  const liveExtensions = await liveIds(Extension, ctx, transaction, { deletedAt: null });
  const rows = await ExtensionMember.findAll({
    where: { entryId, organisationId: ctx.organisation.id, keyPosition: { [Op.ne]: null } },
    order: [['keyPosition', 'ASC']],
    transaction,
  });
  return rows.filter((row) => liveExtensions.has(row.extensionId));
}

/** The members of an extension whose entries are live, in hunt order. */
async function liveMembers(ctx, extensionId, transaction) {
  const liveEntries = await liveIds(DirectoryEntry, ctx, transaction, { deletedAt: null });
  const rows = await ExtensionMember.findAll({ where: { extensionId }, order: [['huntPosition', 'ASC']], transaction });
  return { all: rows, live: rows.filter((row) => liveEntries.has(row.entryId)) };
}

/** The numbers routed to an extension, as `+E.164`. */
async function numbersOf(extensionId, transaction) {
  const rows = await PhoneNumber.findAll({ where: { extensionId }, attributes: ['number'], transaction });
  return rows.map((row) => plusE164(row.number));
}

/** Other live extensions whose settings send calls to this one. */
async function destinationOf(ctx, extensionId, transaction) {
  const others = await Extension.findAll({
    where: { organisationId: ctx.organisation.id, deletedAt: null, id: { [Op.ne]: extensionId } },
    attributes: ['id', 'number', 'params'],
    transaction,
  });
  return others
    .filter((other) => destinationsIn(other.params).some(({ destination }) => destination.kind === 'extension' && destination.extensionId === extensionId))
    .map((other) => ({ extensionId: other.id, number: other.number }));
}

// ---------------------------------------------------------------------------
// Entries

async function checkLogin(ctx, loginUserId, entryId, transaction) {
  if (!loginUserId) return;
  const user = await User.findOne({ where: { id: loginUserId, organisationId: ctx.organisation.id }, attributes: ['id'], transaction });
  if (!user) throw new PbxError(400, 'login_not_in_organisation', 'That login does not belong to this organisation.', { field: 'loginUserId' });
  const linked = await DirectoryEntry.findOne({
    where: { organisationId: ctx.organisation.id, loginUserId, deletedAt: null, ...(entryId ? { id: { [Op.ne]: entryId } } : {}) },
    attributes: ['id'],
    transaction,
  });
  if (linked) throw new PbxError(409, 'login_already_linked', 'That login is already linked to another person.', { field: 'loginUserId' });
}

function normalised(input) {
  const checked = normaliseEntryFields(input);
  if (!checked.ok) throw new PbxError(400, checked.code, checked.error, { field: checked.field });
  return checked.fields;
}

export function createEntry(ctx, input = {}) {
  return runWrite(ctx, { kind: 'entry_created' }, async (state) => {
    const { transaction } = state;
    const { extension: digits, ...fields } = normalised(input);
    if (!fields.name) throw new PbxError(400, 'name_required', 'A name is needed.', { field: 'name' });
    const kind = fields.kind || 'person';
    if (fields.discloseNumbers && kind === 'person') {
      throw new PbxError(400, 'person_disclosure', "A person's numbers are never given out.", { field: 'discloseNumbers' });
    }
    if (fields.loginUserId && kind !== 'person') {
      throw new PbxError(400, 'login_person_only', 'Only a person can be linked to a login.', { field: 'loginUserId' });
    }
    await checkLogin(ctx, fields.loginUserId, null, transaction);
    const entry = await DirectoryEntry.create({
      ...fields,
      kind,
      notes: fields.notes || {},
      organisationId: ctx.organisation.id,
      createdBy: ctx.actor?.userId ?? null,
    }, { transaction });
    change(state, 'entry', entry.id, 'create', null, { name: entry.name, kind: entry.kind });
    if (digits) {
      await insertExtension(ctx, state, { number: digits, type: input.extensionType || 'connection', entryId: entry.id });
    }
    return async (t) => ({ entry: entryView(entry, await loadIndex(ctx.organisation.id, { transaction: t })) });
  });
}

export function updateEntry(ctx, entryId, input = {}) {
  return runWrite(ctx, { kind: 'labels', entryId }, async (state) => {
    const { transaction } = state;
    const entry = await liveEntry(ctx, entryId, transaction);
    if (!entry) throw notFound('Entry not found');
    const hasDigits = 'extension' in input;
    const { extension: digits, notes, ...fields } = normalised(input);
    const before = valuesOf(entry);
    const own = await extensionOfEntry(ctx, entry.id, transaction);

    if (fields.kind && fields.kind !== entry.kind) {
      // Between a person and a team or service the meaning of the entry's
      // extension would change, and members and phone people must be persons.
      const crossing = (fields.kind === 'person') !== (entry.kind === 'person');
      if (crossing) {
        const memberOf = await ExtensionMember.count({ where: { entryId: entry.id }, transaction });
        const onPhones = await PhonePerson.count({ where: { entryId: entry.id }, transaction });
        if ((own && own.type !== 'connection') || memberOf || onPhones) {
          throw new PbxError(409, 'kind_change_blocked',
            'Change the extension to "Through a connection" and take this entry off extensions and phones first.', { field: 'kind' });
        }
      }
      // A person never gives out numbers, so the setting goes off with the change.
      if (fields.kind === 'person' && fields.discloseNumbers === undefined) fields.discloseNumbers = false;
    }
    const kind = fields.kind || entry.kind;
    if (kind === 'person' && fields.discloseNumbers) {
      throw new PbxError(400, 'person_disclosure', "A person's numbers are never given out.", { field: 'discloseNumbers' });
    }
    if (kind !== 'person' && 'loginUserId' in fields && fields.loginUserId) {
      throw new PbxError(400, 'login_person_only', 'Only a person can be linked to a login.', { field: 'loginUserId' });
    }
    if (kind !== 'person' && fields.kind) fields.loginUserId = null;
    if (fields.loginUserId) await checkLogin(ctx, fields.loginUserId, entry.id, transaction);

    if (notes !== undefined) {
      // Merged one level deep. A key set to null is removed.
      const merged = { ...(entry.notes || {}) };
      for (const [key, value] of Object.entries(notes || {})) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      fields.notes = notes === null ? {} : merged;
    }
    await entry.update(fields, { transaction });
    change(state, 'entry', entry.id, 'update', pick(before, Object.keys(fields)), pick(valuesOf(entry), Object.keys(fields)));
    if (own && fields.name && fields.name !== before.name) state.relabelled.add(own.id);

    if (hasDigits) {
      if (digits && !own) await insertExtension(ctx, state, { number: digits, type: input.extensionType || 'connection', entryId: entry.id });
      else if (digits && own && own.number !== digits) await changeExtension(ctx, state, own, { number: digits });
      else if (!digits && own) await removeExtension(ctx, state, own);
    }
    return async (t) => ({ entry: entryView(await entry.reload({ transaction: t }), await loadIndex(ctx.organisation.id, { transaction: t })) });
  });
}

const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key] ?? null]));
// A copy: `get({ plain: true })` can hand back the row's own values, which change with the row.
const valuesOf = (row) => ({ ...row.get({ plain: true }) });

export function deleteEntry(ctx, entryId) {
  return runWrite(ctx, { kind: 'entry_removed', entryId }, async (state) => {
    const { transaction } = state;
    const entry = await liveEntry(ctx, entryId, transaction);
    if (!entry) throw notFound('Entry not found');
    const own = await extensionOfEntry(ctx, entry.id, transaction);
    if (own) {
      if (entry.kind === 'person' && own.type !== 'connection') {
        // A person's own extension goes with them only when nobody else uses it.
        const { live } = await liveMembers(ctx, own.id, transaction);
        const others = live.filter((member) => member.entryId !== entry.id);
        const numbers = await numbersOf(own.id, transaction);
        if (others.length || numbers.length) {
          throw new PbxError(409, 'owned_extension_in_use',
            'Move or remove the members and numbers of this person\'s extension first.',
            { detail: { members: others.map((member) => member.entryId), numbers } });
        }
      }
      await removeExtension(ctx, state, own);
    }
    await entry.update({ deletedAt: new Date() }, { transaction });
    change(state, 'entry', entry.id, 'delete', { name: entry.name, kind: entry.kind }, null);
    return {};
  });
}

// ---------------------------------------------------------------------------
// Extensions

async function checkExtensionShape(ctx, state, { extension, type, number, entry, forwardTo, connectionId, instanceId, params, outboundNumber }) {
  const { transaction } = state;
  const release = pbxRelease();
  if (!EXTENSION_TYPES.includes(type)) {
    throw new PbxError(400, 'invalid_type', `type must be one of ${EXTENSION_TYPES.join(', ')}`, { field: 'type' });
  }
  if (type !== 'connection') requireGate(ctx, 'type');
  if (!releasedExtensionTypes(release).includes(type)) {
    throw new PbxError(409, 'extension_type_not_available', 'This type of extension is not available yet.', { field: 'type' });
  }
  if (!/^[0-9]{1,8}$/.test(String(number ?? ''))) {
    throw new PbxError(400, 'invalid_extension', 'An extension is 1 to 8 digits.', { field: 'number' });
  }
  if (type !== 'connection' && isReservedExtensionNumber(number)) {
    throw new PbxError(400, 'extension_number_reserved', 'An extension cannot be or begin with 999, 112 or 911.', { field: 'number' });
  }
  if (type === 'agent' && entry) {
    throw new PbxError(400, 'agent_extension_has_no_entry', 'An agent extension does not belong to an entry.', { field: 'entryId' });
  }
  if (type !== 'agent' && !entry) {
    throw new PbxError(400, 'extension_entry_required', 'An extension belongs to a person, a team or a service.', { field: 'entryId' });
  }
  if (entry?.kind === 'person' && (type === 'queue' || type === 'agent')) {
    throw new PbxError(400, 'type_not_for_person', "A person's own extension cannot be a queue or an agent.", { field: 'type' });
  }
  const taken = await Extension.findOne({
    where: { organisationId: ctx.organisation.id, number, deletedAt: null, ...(extension ? { id: { [Op.ne]: extension.id } } : {}) },
    attributes: ['id'],
    transaction,
  });
  if (taken) throw new PbxError(409, 'extension_number_taken', 'That extension number is already in use.', { field: 'number' });

  let forward = null;
  if (type === 'forward') {
    if (!forwardTo) throw new PbxError(400, 'forward_to_required', 'A forward extension needs a number to send calls to.', { field: 'forwardTo' });
    forward = toE164(forwardTo);
    if (!forward) throw new PbxError(400, 'invalid_phone', 'Enter a full phone number to forward to.', { field: 'forwardTo' });
  }
  if (connectionId) {
    if (type !== 'connection') {
      throw new PbxError(400, 'connection_not_found', 'Only an extension through a connection names a connection.', { field: 'connectionId' });
    }
    const connection = isId(connectionId) && await PhoneRegistration.findOne({
      where: { id: connectionId, organisationId: ctx.organisation.id, ...notADeviceLine },
      attributes: ['id'],
      transaction,
    });
    if (!connection) throw new PbxError(400, 'connection_not_found', 'That connection does not belong to this organisation.', { field: 'connectionId' });
  }
  const checked = validateExtensionParams(type, params, { release });
  if (!checked.ok) {
    throw new PbxError(checked.code === 'invalid_params' ? 400 : 409, checked.code, checked.error, { field: checked.field });
  }
  for (const { key, destination } of destinationsIn(checked.params)) {
    if (destination.kind !== 'extension') continue;
    const target = extension?.id === destination.extensionId ? null : await liveExtension(ctx, destination.extensionId, transaction);
    if (!target) {
      throw new PbxError(400, 'invalid_destination', 'A call can only be sent on to another extension of this organisation.', { field: `params.${key}` });
    }
  }
  let outbound = null;
  if (outboundNumber) {
    outbound = toE164(outboundNumber);
    const routed = extension ? await numbersOf(extension.id, transaction) : [];
    if (!outbound || !routed.includes(outbound)) {
      throw new PbxError(400, 'outbound_number_not_routed', 'The number shown on calls out must be one that rings this extension.', { field: 'outboundNumber' });
    }
  }
  return { forwardTo: forward, params: checked.params, outboundNumber: outbound, instanceId: type === 'agent' ? instanceId ?? null : null };
}

/** Whether an extension of this type on this entry has an owner's member row. */
const hasOwnerRow = (type, entry) => entry?.kind === 'person' && MEMBER_TYPES.has(type);

async function insertExtension(ctx, state, input) {
  const { transaction } = state;
  const type = input.type || 'connection';
  let entry = null;
  if (input.entryId) {
    entry = await liveEntry(ctx, input.entryId, transaction);
    if (!entry) throw notFound('Entry not found');
    if (await extensionOfEntry(ctx, entry.id, transaction)) {
      throw new PbxError(409, 'entry_has_extension', 'This entry already has an extension.', { field: 'entryId' });
    }
  }
  const shape = await checkExtensionShape(ctx, state, { ...input, type, entry });
  if (input.members?.length && !MEMBER_TYPES.has(type)) {
    throw new PbxError(409, 'member_not_allowed_on_type', 'An extension of this type has no members.', { field: 'members' });
  }
  const extension = await Extension.create({
    organisationId: ctx.organisation.id,
    entryId: entry?.id ?? null,
    number: String(input.number),
    type,
    connectionId: type === 'connection' ? input.connectionId ?? null : null,
    instanceId: shape.instanceId,
    forwardTo: shape.forwardTo,
    params: shape.params,
    outboundNumber: shape.outboundNumber,
    createdBy: ctx.actor?.userId ?? null,
  }, { transaction });
  change(state, 'extension', extension.id, 'create', null, { number: extension.number, type, entryId: extension.entryId });
  if (hasOwnerRow(type, entry)) {
    await ExtensionMember.create({
      organisationId: ctx.organisation.id, extensionId: extension.id, entryId: entry.id, huntPosition: 1, keyPosition: null,
    }, { transaction });
  }
  for (const memberId of input.members || []) {
    if (memberId !== entry?.id) await insertMember(ctx, state, extension, { entryId: memberId });
  }
  state.cause = { kind: 'extension_created', extensionId: extension.id };
  return extension;
}

export function createExtension(ctx, input = {}) {
  return runWrite(ctx, { kind: 'extension_created' }, async (state) => {
    const extension = await insertExtension(ctx, state, input);
    return async (t) => ({ extension: extensionView(await extension.reload({ transaction: t }), await loadIndex(ctx.organisation.id, { transaction: t })) });
  });
}

async function changeExtension(ctx, state, extension, patch) {
  const { transaction } = state;
  const before = valuesOf(extension);
  let entry = extension.entryId ? await liveEntry(ctx, extension.entryId, transaction) : null;
  const type = patch.type ?? extension.type;

  if ('entryId' in patch && patch.entryId !== extension.entryId) {
    // Moving the extension to another entry changes its owner.
    const target = patch.entryId ? await liveEntry(ctx, patch.entryId, transaction) : null;
    if (patch.entryId && !target) throw notFound('Entry not found');
    if (target && await extensionOfEntry(ctx, target.id, transaction)) {
      throw new PbxError(409, 'entry_has_extension', 'That entry already has an extension.', { field: 'entryId' });
    }
    if (hasOwnerRow(extension.type, entry)) {
      await ExtensionMember.destroy({ where: { extensionId: extension.id, entryId: entry.id }, transaction });
    }
    entry = target;
  }

  const { live } = await liveMembers(ctx, extension.id, transaction);
  const others = live.filter((member) => member.entryId !== before.entryId);
  if (type !== extension.type && !MEMBER_TYPES.has(type) && others.length) {
    throw new PbxError(409, 'extension_has_members', 'Remove the members of this extension before changing its type.',
      { field: 'type', detail: { members: others.map((member) => member.entryId) } });
  }

  const merged = { ...(extension.params || {}) };
  if (patch.params && typeof patch.params === 'object') {
    for (const [key, value] of Object.entries(patch.params)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
  }
  const next = {
    number: patch.number !== undefined ? String(patch.number) : extension.number,
    forwardTo: patch.forwardTo !== undefined ? patch.forwardTo : extension.forwardTo,
    connectionId: patch.connectionId !== undefined ? patch.connectionId : (type === 'connection' ? extension.connectionId : null),
    instanceId: patch.instanceId !== undefined ? patch.instanceId : extension.instanceId,
    outboundNumber: patch.outboundNumber !== undefined ? patch.outboundNumber : extension.outboundNumber,
  };
  const shape = await checkExtensionShape(ctx, state, { extension, type, entry, ...next, params: 'params' in patch && patch.params === null ? {} : merged });

  await extension.update({
    entryId: entry?.id ?? null,
    number: next.number,
    type,
    connectionId: type === 'connection' ? next.connectionId ?? null : null,
    instanceId: shape.instanceId,
    forwardTo: type === 'forward' ? shape.forwardTo : null,
    params: shape.params,
    outboundNumber: shape.outboundNumber,
  }, { transaction });

  // The owner's member row follows the type and the entry.
  const ownerRow = entry ? await ExtensionMember.findOne({ where: { extensionId: extension.id, entryId: entry.id }, transaction }) : null;
  if (hasOwnerRow(type, entry) && !ownerRow) {
    const { all } = await liveMembers(ctx, extension.id, transaction);
    const created = await ExtensionMember.create({
      organisationId: ctx.organisation.id, extensionId: extension.id, entryId: entry.id, huntPosition: POSITION_PARK * 2, keyPosition: null,
    }, { transaction });
    await writeOrder(ExtensionMember, 'huntPosition', [created, ...all], [created.id, ...all.map((row) => row.id)], transaction);
  } else if (hasOwnerRow(type, entry) && ownerRow && ownerRow.keyPosition !== null) {
    // A member who becomes the owner has the extension first, not among the shared keys.
    await ownerRow.update({ keyPosition: null }, { transaction });
    const shared = await sharedMemberships(ctx, entry.id, transaction);
    await writeKeyOrder(ctx, entry.id, shared.map((row) => row.extensionId), transaction);
  } else if (!hasOwnerRow(type, entry) && ownerRow && entry?.kind === 'person' && entry.id === extension.entryId) {
    await ownerRow.destroy({ transaction });
  }

  const after = valuesOf(extension);
  const keys = ['number', 'type', 'entryId', 'connectionId', 'instanceId', 'forwardTo', 'params', 'outboundNumber'];
  change(state, 'extension', extension.id, 'update', pick(before, keys), pick(after, keys));
  if (after.number !== before.number) state.relabelled.add(extension.id);
  if (after.type !== before.type) state.cause = { kind: 'type_changed', extensionId: extension.id, detail: { from: before.type, to: after.type } };
  else if (state.cause?.kind !== 'labels') state.cause = { kind: 'labels', extensionId: extension.id };
  return extension;
}

export function updateExtension(ctx, extensionId, patch = {}) {
  return runWrite(ctx, { kind: 'labels', extensionId }, async (state) => {
    const extension = await liveExtension(ctx, extensionId, state.transaction);
    if (!extension) throw notFound('Extension not found');
    await changeExtension(ctx, state, extension, patch);
    return async (t) => ({ extension: extensionView(await extension.reload({ transaction: t }), await loadIndex(ctx.organisation.id, { transaction: t })) });
  });
}

async function removeExtension(ctx, state, extension) {
  const { transaction } = state;
  const numbers = await numbersOf(extension.id, transaction);
  if (numbers.length) {
    throw new PbxError(409, 'extension_has_numbers', 'Point the numbers that ring this extension somewhere else first.', { detail: { numbers } });
  }
  const usedBy = await destinationOf(ctx, extension.id, transaction);
  if (usedBy.length) {
    throw new PbxError(409, 'extension_is_destination', 'Other extensions send calls to this one. Change them first.', { detail: { extensions: usedBy } });
  }
  const { live } = await liveMembers(ctx, extension.id, transaction);
  await extension.update({ deletedAt: new Date() }, { transaction });
  // Each member's remaining shared keys close up.
  for (const member of live) {
    if (member.keyPosition === null) continue;
    const shared = await sharedMemberships(ctx, member.entryId, transaction);
    await writeKeyOrder(ctx, member.entryId, shared.map((row) => row.extensionId), transaction);
  }
  change(state, 'extension', extension.id, 'delete', { number: extension.number, type: extension.type, entryId: extension.entryId }, null);
  state.cause = { kind: 'extension_removed', extensionId: extension.id };
  state.dependents = { numbers: [], destinationOf: [], agentsTransferringHere: [] };
}

export function deleteExtension(ctx, extensionId) {
  return runWrite(ctx, { kind: 'extension_removed', extensionId }, async (state) => {
    const extension = await liveExtension(ctx, extensionId, state.transaction);
    if (!extension) throw notFound('Extension not found');
    await removeExtension(ctx, state, extension);
    return {};
  });
}

// ---------------------------------------------------------------------------
// Members

async function memberTarget(ctx, extensionId, transaction) {
  const extension = await liveExtension(ctx, extensionId, transaction);
  if (!extension) throw notFound('Extension not found');
  if (!MEMBER_TYPES.has(extension.type)) {
    throw new PbxError(409, 'member_not_allowed_on_type', 'An extension of this type has no members.');
  }
  return extension;
}

async function insertMember(ctx, state, extension, { entryId, huntPosition, keyPosition }) {
  const { transaction } = state;
  const entry = await liveEntry(ctx, entryId, transaction);
  if (!entry) throw notFound('Person not found');
  if (entry.kind !== 'person') throw new PbxError(400, 'member_not_person', 'Only a person can be a member.', { field: 'entryId' });
  const { all, live } = await liveMembers(ctx, extension.id, transaction);
  if (all.some((row) => row.entryId === entry.id)) {
    throw new PbxError(409, 'already_member', 'That person is already a member.', { field: 'entryId' });
  }
  const shared = await sharedMemberships(ctx, entry.id, transaction);
  const row = await ExtensionMember.create({
    organisationId: ctx.organisation.id,
    extensionId: extension.id,
    entryId: entry.id,
    // Parked: the two orders are written below.
    huntPosition: POSITION_PARK * 2,
    keyPosition: POSITION_PARK * 2,
  }, { transaction });

  const huntOrder = live.map((member) => member.id);
  const huntAt = Number.isInteger(huntPosition) ? Math.min(Math.max(huntPosition, 1), huntOrder.length + 1) : huntOrder.length + 1;
  huntOrder.splice(huntAt - 1, 0, row.id);
  await writeOrder(ExtensionMember, 'huntPosition', [...all, row], huntOrder, transaction);

  const keyOrder = shared.map((membership) => membership.extensionId);
  const keyAt = Number.isInteger(keyPosition) ? Math.min(Math.max(keyPosition, 1), keyOrder.length + 1) : keyOrder.length + 1;
  keyOrder.splice(keyAt - 1, 0, extension.id);
  await writeKeyOrder(ctx, entry.id, keyOrder, transaction);

  await row.reload({ transaction });
  change(state, 'member', row.id, 'create', null, { extensionId: extension.id, entryId: entry.id, huntPosition: row.huntPosition, keyPosition: row.keyPosition });
  return row;
}

const membersOut = async (ctx, extension, transaction) => {
  const view = extensionView(extension, await loadIndex(ctx.organisation.id, { transaction }));
  return view.members;
};

export function addMember(ctx, extensionId, input = {}) {
  requireGate(ctx);
  return runWrite(ctx, { kind: 'member_added', extensionId, entryId: input.entryId }, async (state) => {
    const extension = await memberTarget(ctx, extensionId, state.transaction);
    const row = await insertMember(ctx, state, extension, input);
    return async (t) => ({
      member: (await membersOut(ctx, extension, t)).find((member) => member.entryId === row.entryId),
    });
  });
}

async function dropMember(ctx, state, extension, row) {
  const { transaction } = state;
  if (row.keyPosition === null && extension.entryId === row.entryId) {
    throw new PbxError(409, 'owner_not_removable', 'The owner of an extension cannot be removed from it.');
  }
  const before = valuesOf(row);
  await row.destroy({ transaction });
  const { all, live } = await liveMembers(ctx, extension.id, transaction);
  await writeOrder(ExtensionMember, 'huntPosition', all, live.map((member) => member.id), transaction);
  const shared = await sharedMemberships(ctx, before.entryId, transaction);
  await writeKeyOrder(ctx, before.entryId, shared.map((membership) => membership.extensionId), transaction);
  change(state, 'member', before.id, 'delete', pick(before, ['extensionId', 'entryId', 'huntPosition', 'keyPosition']), null);
}

export function removeMember(ctx, extensionId, entryId) {
  requireGate(ctx);
  return runWrite(ctx, { kind: 'member_removed', extensionId, entryId }, async (state) => {
    const extension = await liveExtension(ctx, extensionId, state.transaction);
    if (!extension) throw notFound('Extension not found');
    const row = isId(entryId) && await ExtensionMember.findOne({ where: { extensionId: extension.id, entryId }, transaction: state.transaction });
    if (!row) throw notFound('Member not found');
    await dropMember(ctx, state, extension, row);
    return {};
  });
}

/** Set the whole member list of an extension, in hunt order. */
export function setMembers(ctx, extensionId, entryIds) {
  requireGate(ctx);
  return runWrite(ctx, { kind: 'member_added', extensionId }, async (state) => {
    const { transaction } = state;
    const extension = await memberTarget(ctx, extensionId, transaction);
    if (!Array.isArray(entryIds) || new Set(entryIds).size !== entryIds.length) {
      throw new PbxError(400, 'hunt_order_mismatch', 'entryIds must list each member once.', { field: 'entryIds' });
    }
    const { live } = await liveMembers(ctx, extension.id, transaction);
    const ownerRow = live.find((member) => member.keyPosition === null && member.entryId === extension.entryId);
    if (ownerRow && !entryIds.includes(ownerRow.entryId)) {
      throw new PbxError(409, 'owner_not_removable', 'The owner of an extension cannot be removed from it.');
    }
    let removed = 0;
    for (const member of live) {
      if (!entryIds.includes(member.entryId)) {
        await dropMember(ctx, state, extension, member);
        removed += 1;
      }
    }
    let added = 0;
    for (const entryId of entryIds) {
      if (!live.some((member) => member.entryId === entryId)) {
        await insertMember(ctx, state, extension, { entryId });
        added += 1;
      }
    }
    const now = await liveMembers(ctx, extension.id, transaction);
    const order = entryIds.map((entryId) => now.live.find((member) => member.entryId === entryId)?.id).filter(Boolean);
    await writeOrder(ExtensionMember, 'huntPosition', now.all, order, transaction);
    if (removed && !added) state.cause = { kind: 'member_removed', extensionId: extension.id };
    change(state, 'huntOrder', extension.id, 'update', live.map((member) => member.entryId), entryIds);
    return async (t) => ({ members: await membersOut(ctx, extension, t) });
  });
}

/** Set the order of a person's shared extensions on their phones. */
export function setKeyOrder(ctx, entryId, extensionIds) {
  requireGate(ctx);
  return runWrite(ctx, { kind: 'key_order', entryId }, async (state) => {
    const { transaction } = state;
    const entry = await liveEntry(ctx, entryId, transaction);
    if (!entry) throw notFound('Person not found');
    if (entry.kind !== 'person') throw new PbxError(400, 'member_not_person', 'Only a person has a key order.');
    const shared = await sharedMemberships(ctx, entry.id, transaction);
    const current = shared.map((membership) => membership.extensionId);
    const same = Array.isArray(extensionIds)
      && extensionIds.length === current.length
      && new Set(extensionIds).size === current.length
      && extensionIds.every((id) => current.includes(id));
    if (!same) {
      throw new PbxError(400, 'key_order_mismatch', "The list must be exactly the person's shared extensions.", { field: 'extensionIds' });
    }
    await writeKeyOrder(ctx, entry.id, extensionIds, transaction);
    change(state, 'keyOrder', entry.id, 'update', current, extensionIds);
    return async (t) => ({
      memberships: entryView(entry, await loadIndex(ctx.organisation.id, { transaction: t })).memberships,
    });
  });
}

// ---------------------------------------------------------------------------
// Phones

async function capacityOfPhone(phone, transaction) {
  const device = phone.deviceId ? await Device.findByPk(phone.deviceId, { transaction }) : null;
  return { device, capacity: phoneCapacity(phone, device) };
}

function tooSmall(capacity, wanted, people) {
  return new PbxError(409, 'phone_too_small',
    capacity <= 1
      ? 'This phone has one line, so it can ring for one person.'
      : `This phone has ${capacity} lines, so it can ring for ${maxPeople(capacity)} people.`,
    { detail: { lines: capacity, maxPeople: maxPeople(capacity), people, wanted } });
}

/** The people a phone may ring for: live persons, no more than the phone can take. */
async function checkPeople(ctx, state, { kind, capacity, entryIds }) {
  if (!Array.isArray(entryIds) || new Set(entryIds).size !== entryIds.length) {
    throw new PbxError(400, 'phone_person_not_person', 'people must list each person once.', { field: 'people' });
  }
  const entries = [];
  for (const entryId of entryIds) {
    const entry = await liveEntry(ctx, entryId, state.transaction);
    if (!entry) throw notFound('Person not found');
    if (entry.kind !== 'person') throw new PbxError(400, 'phone_person_not_person', 'A phone rings for people only.', { field: 'people' });
    entries.push(entry);
  }
  if (kind === 'external') {
    if (entries.length !== 1) throw new PbxError(400, 'external_one_person', 'An outside number rings for exactly one person.', { field: 'people' });
  } else if (entries.length > maxPeople(capacity)) {
    throw tooSmall(capacity, entries.length, entries.map((entry) => ({ entryId: entry.id, name: entry.name })));
  }
  return entries;
}

async function writePeople(ctx, state, phone, entryIds) {
  const { transaction } = state;
  const rows = await PhonePerson.findAll({ where: { phoneId: phone.id }, transaction });
  const liveEntries = await liveIds(DirectoryEntry, ctx, transaction, { deletedAt: null });
  const before = rows.filter((row) => liveEntries.has(row.entryId)).sort((a, b) => a.position - b.position).map((row) => row.entryId);
  for (const row of rows) {
    if (liveEntries.has(row.entryId) && !entryIds.includes(row.entryId)) await row.destroy({ transaction });
  }
  const kept = rows.filter((row) => !liveEntries.has(row.entryId) || entryIds.includes(row.entryId));
  const created = [];
  for (const entryId of entryIds) {
    if (kept.some((row) => row.entryId === entryId)) continue;
    created.push(await PhonePerson.create({
      organisationId: ctx.organisation.id, phoneId: phone.id, entryId, position: POSITION_PARK * 2 + created.length,
    }, { transaction }));
  }
  const all = [...kept, ...created];
  await writeOrder(PhonePerson, 'position', all, entryIds.map((entryId) => all.find((row) => row.entryId === entryId).id), transaction);
  change(state, 'phonePerson', phone.id, 'update', before, entryIds);
  return before;
}

/** Warn when an outside number would start to ring only after its person's extension has stopped. */
async function delayWarning(ctx, state, phone, entryId) {
  if (phone.kind !== 'external' || !phone.ringDelay) return;
  const own = await extensionOfEntry(ctx, entryId, state.transaction);
  const ringSeconds = effectiveParams(own?.params).ringSeconds;
  if (own && phone.ringDelay >= ringSeconds) {
    state.warnings.push({
      code: 'ring_delay_not_less_than_ring_time',
      message: `This phone starts to ring after ${phone.ringDelay} seconds, but extension ${own.number} rings for ${ringSeconds}. It would never ring.`,
    });
  }
}

const phoneOut = (ctx, phone) => async (t) => {
  const { device } = await capacityOfPhone(phone, t);
  return { phone: phoneView(await phone.reload({ transaction: t }), device, await loadIndex(ctx.organisation.id, { transaction: t })) };
};

function externalFields(input, current = {}) {
  const fields = {};
  if (input.number !== undefined || !current.number) {
    const number = input.number ? toE164(input.number) : null;
    if (!number) throw new PbxError(400, 'external_number_required', 'Enter the full outside number.', { field: 'number' });
    fields.number = number;
  }
  if (input.ringDelay !== undefined) {
    if (!Number.isInteger(input.ringDelay) || input.ringDelay < 0 || input.ringDelay > 60) {
      throw new PbxError(400, 'invalid_ring_delay', 'ringDelay must be a whole number of seconds from 0 to 60.', { field: 'ringDelay' });
    }
    fields.ringDelay = input.ringDelay;
  }
  if (input.shows !== undefined) {
    if (!PHONE_SHOWS.includes(input.shows)) throw new PbxError(400, 'invalid_shows', `shows must be one of ${PHONE_SHOWS.join(', ')}`, { field: 'shows' });
    fields.shows = input.shows;
  }
  if (input.keyToAnswer !== undefined) {
    if (typeof input.keyToAnswer !== 'boolean') throw new PbxError(400, 'invalid_key_to_answer', 'keyToAnswer must be true or false.', { field: 'keyToAnswer' });
    fields.keyToAnswer = input.keyToAnswer;
  }
  return fields;
}

async function checkNotOurNumber(ctx, number, transaction) {
  const ours = await PhoneNumber.findOne({
    where: { organisationId: ctx.organisation.id, number: number.replace(/^\+/, '') },
    attributes: ['id'],
    transaction,
  });
  if (ours) throw new PbxError(400, 'external_number_is_ours', "An outside number cannot be one of this organisation's own numbers.", { field: 'number' });
}

const cleanLabel = (label) => {
  const tidy = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!tidy) throw new PbxError(400, 'label_required', 'A phone needs a label.', { field: 'label' });
  return tidy.slice(0, 60);
};

export function createPhone(ctx, input = {}) {
  requireGate(ctx);
  return runWrite(ctx, { kind: 'people_changed' }, async (state) => {
    const { transaction } = state;
    const kind = input.kind;
    if (!PHONE_KINDS.includes(kind)) throw new PbxError(400, 'invalid_kind', `kind must be one of ${PHONE_KINDS.join(', ')}`, { field: 'kind' });
    if (!releasedPhoneKinds().includes(kind)) {
      throw new PbxError(409, 'phone_kind_not_available', 'This kind of phone is not available yet.', { field: 'kind' });
    }
    const label = cleanLabel(input.label);
    const people = input.people ?? [];
    let device = null;
    let fields = {};

    if (kind === 'deskphone') {
      const mac = normaliseMac(input.mac);
      if (!mac || !isSnomMac(mac)) throw new PbxError(400, 'not_a_snom_mac', 'That is not the MAC address of a Snom phone.', { field: 'mac' });
      const model = phoneModel('snom', input.model);
      if (!model?.supported) throw new PbxError(400, 'model_not_supported', 'That model is not supported.', { field: 'model' });
      const held = await Device.findOne({ where: { vendor: 'snom', mac, releasedAt: null }, transaction });
      if (held && held.organisationId !== ctx.organisation.id) {
        throw new PbxError(409, 'phone_held_elsewhere', 'This phone is registered to another organisation. Contact support.', { field: 'mac' });
      }
      if (held && await Phone.findOne({ where: { deviceId: held.id, removedAt: null }, attributes: ['id'], transaction })) {
        throw new PbxError(409, 'phone_in_directory', 'This phone is already in your directory.', { field: 'mac' });
      }
      await checkPeople(ctx, state, { kind, capacity: model.lines, entryIds: people });
      // A phone this organisation removed comes back on its old row.
      device = held
        ? await held.update({ model: model.name, reportedModel: null, removedAt: null, provisioningState: 'waiting', failure: null, fetchedVersion: null }, { transaction })
        : await Device.create({ organisationId: ctx.organisation.id, vendor: 'snom', mac, model: model.name }, { transaction });
    } else if (kind === 'external') {
      fields = { ringDelay: 0, shows: 'caller', keyToAnswer: true, ...externalFields(input) };
      await checkNotOurNumber(ctx, fields.number, transaction);
      await checkPeople(ctx, state, { kind, capacity: 0, entryIds: people });
    } else {
      await checkPeople(ctx, state, { kind, capacity: phoneCapacity({ kind }, null), entryIds: people });
    }

    const phone = await Phone.create({
      organisationId: ctx.organisation.id,
      deviceId: device?.id ?? null,
      label,
      kind,
      ...fields,
      addedBy: ctx.actor?.userId ?? null,
    }, { transaction });
    change(state, 'phone', phone.id, 'create', null, { label, kind });
    await writePeople(ctx, state, phone, people);
    if (people[0]) await delayWarning(ctx, state, phone, people[0]);
    state.cause = { kind: 'people_changed', phoneId: phone.id, detail: { phone: 'added' } };
    return phoneOut(ctx, phone);
  });
}

export function updatePhone(ctx, phoneId, input = {}) {
  requireGate(ctx);
  return runWrite(ctx, { kind: 'labels', phoneId }, async (state) => {
    const { transaction } = state;
    const phone = await livePhone(ctx, phoneId, transaction);
    if (!phone) throw notFound('Phone not found');
    const before = valuesOf(phone);
    const fields = {};
    if (input.label !== undefined) fields.label = cleanLabel(input.label);
    if (phone.kind === 'external') {
      Object.assign(fields, externalFields(input, phone));
      if (fields.number && fields.number !== phone.number) await checkNotOurNumber(ctx, fields.number, transaction);
    }
    if (input.model !== undefined && phone.kind === 'deskphone') {
      const { device } = await capacityOfPhone(phone, transaction);
      // Once the phone has said what it is, the phone wins.
      if (device?.reportedModel) {
        throw new PbxError(409, 'phone_model_reported', 'This phone has reported its model, so the model cannot be changed by hand.', { field: 'model' });
      }
      const model = phoneModel('snom', input.model);
      if (!model?.supported) throw new PbxError(400, 'model_not_supported', 'That model is not supported.', { field: 'model' });
      const rows = await PhonePerson.findAll({ where: { phoneId: phone.id }, transaction });
      const liveEntries = await liveIds(DirectoryEntry, ctx, transaction, { deletedAt: null });
      const count = rows.filter((row) => liveEntries.has(row.entryId)).length;
      if (count > maxPeople(model.lines)) throw tooSmall(model.lines, count, []);
      await device.update({ model: model.name }, { transaction });
      state.cause = { kind: 'model_reported', phoneId: phone.id, detail: { typed: model.name } };
    }
    await phone.update(fields, { transaction });
    change(state, 'phone', phone.id, 'update', pick(before, Object.keys(fields)), pick(valuesOf(phone), Object.keys(fields)));
    if (phone.kind === 'external') {
      const person = await PhonePerson.findOne({ where: { phoneId: phone.id }, transaction });
      if (person) await delayWarning(ctx, state, phone, person.entryId);
    }
    return phoneOut(ctx, phone);
  });
}

/** Remove a phone. Its lines and their SIP accounts go at once. */
export function deletePhone(ctx, phoneId) {
  requireGate(ctx);
  return runWrite(ctx, { kind: 'people_changed', phoneId, detail: { phone: 'removed' } }, async (state) => {
    const { transaction } = state;
    const phone = await livePhone(ctx, phoneId, transaction);
    if (!phone) throw notFound('Phone not found');
    const index = await loadIndex(ctx.organisation.id, { transaction });
    const { device } = await capacityOfPhone(phone, transaction);
    const view = phoneView(phone, device, index);
    // The line working-out no longer sees a removed phone, so its effect is recorded here.
    state.extraPhones.push({
      phoneId: phone.id,
      label: phone.label,
      kind: phone.kind,
      people: view.people.map(({ entryId, name }) => ({ entryId, name })),
      before: view.lines.map((line) => ({ key: line.key, kind: line.kind, extensionId: line.extensionId, covers: line.covers, label: line.label, lineNumber: line.lineNumber })),
      after: [],
      added: [],
      removed: view.lines.map((line) => ({ key: line.key, ...(line.kind === 'other' ? { kind: 'other' } : { extensionId: line.extensionId }) })),
      moved: [],
      sipAccounts: { create: 0, remove: phone.kind === 'deskphone' ? view.lines.length : 0 },
      resync: 'none',
      warnings: [],
    });
    if (!ctx.dryRun) await removeLinesOfPhone({ phoneId: phone.id, transaction });
    const now = new Date();
    await phone.update({ removedAt: now }, { transaction });
    if (device) await device.update({ removedAt: now }, { transaction });
    change(state, 'phone', phone.id, 'delete', { label: phone.label, kind: phone.kind }, null);
    return {};
  });
}

async function peopleTarget(ctx, state, phoneId) {
  const phone = await livePhone(ctx, phoneId, state.transaction);
  if (!phone) throw notFound('Phone not found');
  const { capacity } = await capacityOfPhone(phone, state.transaction);
  return { phone, capacity };
}

const peopleOut = (ctx, phone) => async (t) => ({ people: (await phoneOut(ctx, phone)(t)).phone.people });

/** Set the whole list of people a phone rings for, in order. */
export function setPhonePeople(ctx, phoneId, entryIds) {
  requireGate(ctx);
  return runWrite(ctx, { kind: 'people_changed', phoneId }, async (state) => {
    const { phone, capacity } = await peopleTarget(ctx, state, phoneId);
    await checkPeople(ctx, state, { kind: phone.kind, capacity, entryIds });
    const before = await writePeople(ctx, state, phone, entryIds);
    const sameSet = before.length === entryIds.length && before.every((id) => entryIds.includes(id));
    if (sameSet) state.cause = { kind: 'people_order', phoneId: phone.id };
    return peopleOut(ctx, phone);
  });
}

export function addPhonePerson(ctx, phoneId, { entryId, position } = {}) {
  requireGate(ctx);
  return runWrite(ctx, { kind: 'people_changed', phoneId, entryId }, async (state) => {
    const { phone, capacity } = await peopleTarget(ctx, state, phoneId);
    const rows = await PhonePerson.findAll({ where: { phoneId: phone.id }, order: [['position', 'ASC']], transaction: state.transaction });
    const liveEntries = await liveIds(DirectoryEntry, ctx, state.transaction, { deletedAt: null });
    const current = rows.filter((row) => liveEntries.has(row.entryId)).map((row) => row.entryId);
    if (current.includes(entryId)) return peopleOut(ctx, phone);
    const next = [...current];
    const at = Number.isInteger(position) ? Math.min(Math.max(position, 1), next.length + 1) : next.length + 1;
    next.splice(at - 1, 0, entryId);
    await checkPeople(ctx, state, { kind: phone.kind, capacity, entryIds: next });
    await writePeople(ctx, state, phone, next);
    return peopleOut(ctx, phone);
  });
}

export function removePhonePerson(ctx, phoneId, entryId) {
  requireGate(ctx);
  return runWrite(ctx, { kind: 'people_changed', phoneId, entryId }, async (state) => {
    const { phone } = await peopleTarget(ctx, state, phoneId);
    const rows = await PhonePerson.findAll({ where: { phoneId: phone.id }, order: [['position', 'ASC']], transaction: state.transaction });
    if (!rows.some((row) => row.entryId === entryId)) throw notFound('That person is not on this phone');
    if (phone.kind === 'external') {
      throw new PbxError(400, 'external_one_person', 'An outside number rings for exactly one person. Remove the phone instead.', { field: 'people' });
    }
    const liveEntries = await liveIds(DirectoryEntry, ctx, state.transaction, { deletedAt: null });
    const next = rows.filter((row) => liveEntries.has(row.entryId) && row.entryId !== entryId).map((row) => row.entryId);
    await writePeople(ctx, state, phone, next);
    return peopleOut(ctx, phone);
  });
}

// ---------------------------------------------------------------------------
// Numbers

/**
 * Point a number at an extension, or clear the route. A number rings an
 * extension or an agent, never both: `replace` takes it off its agent first.
 */
export function routeNumber(ctx, phoneNumber, { extensionId, replace = false } = {}) {
  requireGate(ctx, 'extensionId');
  return runWrite(ctx, { kind: 'labels' }, async (state) => {
    const { transaction } = state;
    const row = await PhoneNumber.findByPk(phoneNumber.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row || row.organisationId !== ctx.organisation.id) {
      throw new PbxError(409, 'number_not_held', 'This organisation does not hold that number.');
    }
    const before = { extensionId: row.extensionId, handler: row.handler, instanceId: row.instanceId };
    const number = plusE164(row.number);
    if (extensionId === null) {
      if (row.extensionId) {
        const extension = await Extension.findByPk(row.extensionId, { transaction });
        if (extension?.outboundNumber === number) {
          throw new PbxError(409, 'number_in_use_for_caller_id', 'This number is shown on calls out from its extension. Change that first.');
        }
      }
      // Back to the handler of the number's trunk.
      const trunk = row.aplisayId ? await Trunk.findByPk(row.aplisayId, { attributes: ['handler'], transaction }) : null;
      await row.update({ extensionId: null, handler: row.handler === 'pbx' ? (trunk?.handler || 'livekit') : row.handler }, { transaction });
    } else {
      const extension = await liveExtension(ctx, extensionId, transaction);
      if (!extension) throw notFound('Extension not found');
      if (row.instanceId && !replace) {
        throw new PbxError(409, 'number_in_use', 'This number is attached to an agent. Send replace: true to move it.', { field: 'extensionId' });
      }
      await row.update({ extensionId: extension.id, instanceId: null, handler: 'pbx' }, { transaction });
    }
    change(state, 'number', row.id, 'update', before, { extensionId: row.extensionId, handler: row.handler, instanceId: row.instanceId });
    return { number, extensionId: row.extensionId, handler: row.handler };
  });
}
