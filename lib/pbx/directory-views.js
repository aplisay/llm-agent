/**
 * Reads of the directory, and the shapes the API returns. Every read is
 * scoped to one organisation by the caller.
 */
import {
  DirectoryEntry, Extension, Device, Phone, PhoneChange, User, Op,
} from '../database.js';
import { hasCapability } from '../capabilities.js';
import { indexSnapshot, isPersonal, shownNumber, labelFor } from './snapshot.js';
import { loadSnapshot } from './store.js';
import { maxPeople } from './lines.js';
import { effectiveParams } from './extension-params.js';

export async function loadIndex(organisationId, options = {}) {
  const snapshot = await loadSnapshot(organisationId, options);
  return snapshot ? indexSnapshot(snapshot) : null;
}

const phoneSystemOn = (index) => hasCapability(index.organisation, 'phoneSystem');

export function entryView(entry, index) {
  const extension = index.extensionByEntry.get(entry.id) || null;
  const view = {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    role: entry.role,
    department: entry.department,
    about: entry.about,
    email: entry.email,
    hours: entry.hours,
    notesForAgent: entry.notesForAgent,
    discloseNumbers: entry.discloseNumbers,
    direct: entry.direct,
    mobile: entry.mobile,
    loginUserId: entry.loginUserId,
    notes: entry.notes || {},
    extension: extension?.number ?? null,
    extensionId: extension?.id ?? null,
    extensionType: extension?.type ?? null,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {}),
  };
  if (!phoneSystemOn(index)) return view;
  const memberships = (index.membershipsByEntry.get(entry.id) || []).map(({ extension: shared, keyPosition }) => ({
    extensionId: shared.id,
    number: shared.number,
    name: index.entries.get(shared.entryId)?.name ?? shared.number,
    keyPosition,
  }));
  const phones = (index.phonesByEntry.get(entry.id) || []).map((phone) => ({
    phoneId: phone.id,
    label: phone.label,
    kind: phone.kind,
    position: (index.peopleByPhone.get(phone.id) || []).find((person) => person.entryId === entry.id)?.position ?? null,
  }));
  const ours = (ext) => Boolean(ext) && ext.type !== 'connection';
  return {
    ...view,
    memberships,
    phones,
    onPhoneSystem: entry.kind === 'person'
      && (ours(extension) || (index.membershipsByEntry.get(entry.id) || []).some((m) => ours(m.extension))),
  };
}

export function extensionView(extension, index) {
  const entry = extension.entryId ? index.entries.get(extension.entryId) : null;
  const personal = isPersonal(index, extension);
  const shown = shownNumber(index, extension);
  const params = effectiveParams(extension.params);
  const members = (index.membersByExtension.get(extension.id) || []).map((member) => ({
    entryId: member.entryId,
    name: index.entries.get(member.entryId)?.name ?? '',
    huntPosition: member.huntPosition,
    keyPosition: member.keyPosition,
    owner: personal && member.entryId === extension.entryId,
  }));
  let phoneCount = 0;
  for (const lines of index.linesByPhone.values()) {
    if (lines.some((line) => line.extensionId === extension.id || (line.covers || []).includes(extension.id))) phoneCount += 1;
  }
  return {
    id: extension.id,
    number: extension.number,
    type: extension.type,
    entryId: extension.entryId,
    name: entry?.name ?? extension.number,
    entryKind: entry?.kind ?? null,
    personal,
    ownerEntryId: personal ? extension.entryId : null,
    connectionId: extension.connectionId,
    instanceId: extension.instanceId,
    forwardTo: extension.forwardTo,
    params: {
      ...(extension.params || {}),
      ringSeconds: params.ringSeconds,
      callWaiting: params.callWaiting,
      record: params.record,
    },
    outboundNumber: extension.outboundNumber,
    shownNumber: shown.number,
    shownNumberSource: shown.source,
    numbers: index.numbersByExtension.get(extension.id) || [],
    members,
    phoneCount,
    monthlyCharge: null,
    createdAt: extension.createdAt,
    updatedAt: extension.updatedAt,
    ...(extension.deletedAt ? { deletedAt: extension.deletedAt } : {}),
  };
}

/** A line as the API shows it. Never the username or the password. */
export function lineView(line, phone, index) {
  const extension = line.kind === 'extension' ? index.extensions.get(line.extensionId) : null;
  return {
    id: line.id,
    key: line.position,
    kind: line.kind,
    extensionId: line.extensionId ?? null,
    number: extension?.number ?? null,
    label: labelFor(index, phone, line),
    covers: line.covers || null,
    lineNumber: line.lineNumber,
    registered: Boolean(line.endpoint?.registered),
    lastSeenAt: line.endpoint?.lastSeenAt ?? null,
  };
}

export function phoneView(phone, device, index) {
  const inSnapshot = index.phones.get(phone.id);
  const capacity = inSnapshot?.capacity ?? 0;
  const lines = (index.linesByPhone.get(phone.id) || []).map((line) => lineView(line, inSnapshot || phone, index));
  const people = (index.peopleByPhone.get(phone.id) || []).map((person) => ({
    entryId: person.entryId,
    name: index.entries.get(person.entryId)?.name ?? '',
    position: person.position,
  }));
  const registered = lines.filter((line) => line.registered).length;
  const lastSeen = lines.map((line) => line.lastSeenAt).filter(Boolean).sort().pop() ?? null;
  return {
    id: phone.id,
    label: phone.label,
    kind: phone.kind,
    device: device
      ? {
        id: device.id,
        vendor: device.vendor,
        mac: device.mac,
        model: device.model,
        reportedModel: device.reportedModel,
        state: device.provisioningState,
        failure: device.failure,
        lastFetchAt: device.lastFetchAt,
        certificateCheckedAt: device.certificateCheckedAt,
        firmware: device.firmware,
        updating: device.provisioningState === 'updating',
      }
      : null,
    capacity,
    // How many people the phone can ring for, and whether it has room for one more.
    maxPeople: phone.kind === 'external' ? 1 : maxPeople(capacity),
    roomForPerson: people.length < (phone.kind === 'external' ? 1 : maxPeople(capacity)),
    people,
    lines,
    registered: {
      lines: lines.length,
      registered,
      offlineSince: lines.length && !registered ? lastSeen : null,
    },
    number: phone.number,
    ringDelay: phone.ringDelay,
    shows: phone.shows,
    keyToAnswer: phone.keyToAnswer,
    addedBy: phone.addedBy,
    createdAt: phone.createdAt,
    ...(phone.removedAt ? { removedAt: phone.removedAt } : {}),
  };
}

export async function listEntries(organisationId, { kind, q, includeDeleted = false } = {}) {
  const index = await loadIndex(organisationId);
  if (!index) return null;
  const where = { organisationId, ...(includeDeleted ? {} : { deletedAt: null }) };
  if (kind) where.kind = kind;
  if (q) where.name = { [Op.iLike]: `%${String(q).replace(/[\\%_]/g, '\\$&')}%` };
  const rows = await DirectoryEntry.findAll({ where, order: [['name', 'ASC'], ['id', 'ASC']] });
  const counts = new Map();
  let lastChangeAt = null;
  for (const row of rows) {
    if (row.department) counts.set(row.department, (counts.get(row.department) || 0) + 1);
    if (!lastChangeAt || row.updatedAt > lastChangeAt) lastChangeAt = row.updatedAt;
  }
  return {
    entries: rows.map((row) => entryView(row, index)),
    // Most used first.
    departments: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name),
    meta: { total: rows.length, lastChangeAt },
  };
}

export async function getEntry(organisationId, entryId, options = {}) {
  const row = await DirectoryEntry.findOne({ where: { id: entryId, organisationId, deletedAt: null }, ...options });
  if (!row) return null;
  return entryView(row, await loadIndex(organisationId, options));
}

export async function listExtensions(organisationId, { type, personal } = {}) {
  const index = await loadIndex(organisationId);
  if (!index) return null;
  const rows = await Extension.findAll({
    where: { organisationId, deletedAt: null, ...(type ? { type } : {}) },
    order: [['number', 'ASC']],
  });
  return rows
    .filter((row) => index.extensions.has(row.id))
    .map((row) => extensionView(row, index))
    .filter((view) => (personal === undefined ? true : view.personal === personal));
}

export async function getExtension(organisationId, extensionId, options = {}) {
  const row = await Extension.findOne({ where: { id: extensionId, organisationId, deletedAt: null }, ...options });
  if (!row) return null;
  const index = await loadIndex(organisationId, options);
  return index.extensions.has(row.id) ? extensionView(row, index) : null;
}

async function devicesOf(phones, options = {}) {
  const ids = phones.map((phone) => phone.deviceId).filter(Boolean);
  const rows = ids.length ? await Device.findAll({ where: { id: ids }, ...options }) : [];
  return new Map(rows.map((device) => [device.id, device]));
}

export async function listPhones(organisationId, { kind, entryId } = {}) {
  const index = await loadIndex(organisationId);
  if (!index) return null;
  const rows = await Phone.findAll({
    where: { organisationId, removedAt: null, ...(kind ? { kind } : {}) },
    order: [['label', 'ASC'], ['id', 'ASC']],
  });
  const devices = await devicesOf(rows);
  return rows
    .filter((phone) => !entryId || (index.peopleByPhone.get(phone.id) || []).some((person) => person.entryId === entryId))
    .map((phone) => phoneView(phone, devices.get(phone.deviceId) || null, index));
}

export async function getPhone(organisationId, phoneId, options = {}) {
  const phone = await Phone.findOne({ where: { id: phoneId, organisationId, removedAt: null }, ...options });
  if (!phone) return null;
  const devices = await devicesOf([phone], options);
  return phoneView(phone, devices.get(phone.deviceId) || null, await loadIndex(organisationId, options));
}

export async function listChanges(organisationId, phoneId, { limit = 50, before } = {}) {
  const phone = await Phone.findOne({ where: { id: phoneId, organisationId }, attributes: ['id'] });
  if (!phone) return null;
  const size = Math.min(200, Math.max(1, Number(limit) || 50));
  const beforeDate = before ? new Date(before) : null;
  const rows = await PhoneChange.findAll({
    where: {
      phoneId,
      organisationId,
      ...(beforeDate && !Number.isNaN(beforeDate.valueOf()) ? { createdAt: { [Op.lt]: beforeDate } } : {}),
    },
    order: [['createdAt', 'DESC']],
    limit: size,
  });
  const userIds = [...new Set(rows.map((row) => row.actorUserId).filter(Boolean))];
  const users = new Map(
    (userIds.length ? await User.findAll({ where: { id: userIds }, attributes: ['id', 'name'] }) : []).map((user) => [user.id, user.name]),
  );
  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt,
    requestId: row.requestId,
    cause: row.cause,
    before: row.before,
    after: row.after,
    actorKind: row.actorKind,
    actorName: users.get(row.actorUserId) ?? null,
    resync: row.resync,
  }));
}
