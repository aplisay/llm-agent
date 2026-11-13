/**
 * Loads the directory of one organisation from the database as a plain
 * snapshot (lib/pbx/snapshot.js). An organisation's directory is small, so it
 * is read whole.
 */
import {
  Organisation, DirectoryEntry, Extension, ExtensionMember, Device, Phone, PhonePerson, PhoneRule, Line,
  PhoneRegistration, PhoneNumber, Instance,
} from '../database.js';
import { notADeviceLine } from './line-accounts.js';
import { phoneCapacity, phoneLabelChars } from './phone-models.js';
import { destinationsIn } from './extension-params.js';
import { plusE164 } from './numbers.js';

const plain = (rows) => rows.map((row) => row.get({ plain: true }));

export { notADeviceLine };

/**
 * @returns {Promise<object|null>} the snapshot, or null when the organisation does not exist
 */
export async function loadSnapshot(organisationId, { transaction } = {}) {
  const organisation = await Organisation.findByPk(organisationId, {
    attributes: ['id', 'capabilities', 'mainNumber', 'busyStatusVisible'],
    transaction,
  });
  if (!organisation) return null;
  const where = { organisationId };
  const live = { ...where, deletedAt: null };

  const entries = plain(await DirectoryEntry.findAll({ where: live, attributes: ['id', 'kind', 'name'], transaction }));
  const extensions = plain(await Extension.findAll({
    where: live,
    attributes: ['id', 'number', 'type', 'entryId', 'connectionId', 'instanceId', 'forwardTo', 'params', 'outboundNumber'],
    transaction,
  }));
  const members = plain(await ExtensionMember.findAll({
    where,
    attributes: ['id', 'extensionId', 'entryId', 'huntPosition', 'keyPosition'],
    transaction,
  }));
  const phoneRows = await Phone.findAll({ where: { ...where, removedAt: null }, transaction });
  const deviceIds = phoneRows.map((phone) => phone.deviceId).filter(Boolean);
  const devices = new Map(
    (deviceIds.length ? await Device.findAll({ where: { id: deviceIds }, transaction }) : []).map((device) => [device.id, device]),
  );
  const phones = phoneRows.map((phone) => {
    const device = phone.deviceId ? devices.get(phone.deviceId) : null;
    return {
      id: phone.id,
      kind: phone.kind,
      label: phone.label,
      number: phone.number,
      ringDelay: phone.ringDelay,
      shows: phone.shows,
      keyToAnswer: phone.keyToAnswer,
      deviceId: phone.deviceId,
      capacity: phoneCapacity(phone, device),
      labelChars: phoneLabelChars(phone, device),
    };
  });
  const phoneIds = phones.map((phone) => phone.id);
  const byPhone = { phoneId: phoneIds };
  const phonePeople = phoneIds.length
    ? plain(await PhonePerson.findAll({ where: byPhone, attributes: ['id', 'phoneId', 'entryId', 'position'], transaction }))
    : [];
  const rules = phoneIds.length ? plain(await PhoneRule.findAll({ where: byPhone, transaction })) : [];
  const lineRows = phoneIds.length ? plain(await Line.findAll({ where: byPhone, transaction })) : [];
  const endpointIds = lineRows.map((line) => line.endpointId).filter(Boolean);
  const endpoints = new Map(
    (endpointIds.length
      ? await PhoneRegistration.findAll({
        where: { id: endpointIds },
        attributes: ['id', 'username', 'registrar', 'bindings', 'lastSeenAt'],
        transaction,
      })
      : []
    ).map((row) => [row.id, row]),
  );
  const lines = lineRows.map((line) => {
    const endpoint = line.endpointId ? endpoints.get(line.endpointId) : null;
    return {
      id: line.id,
      phoneId: line.phoneId,
      position: line.position,
      kind: line.kind,
      extensionId: line.extensionId,
      covers: line.covers || null,
      lineNumber: Number(line.lineNumber),
      endpointId: line.endpointId,
      endpoint: endpoint
        ? {
          id: endpoint.id,
          username: endpoint.username,
          registrar: endpoint.registrar,
          registered: Array.isArray(endpoint.bindings) && endpoint.bindings.length > 0,
          lastSeenAt: endpoint.lastSeenAt,
        }
        : null,
    };
  });

  const numbers = (await PhoneNumber.findAll({
    where,
    attributes: ['number', 'extensionId', 'aplisayId', 'instanceId', 'emergencyRecordState'],
    transaction,
  })).map((row) => ({
    number: plusE164(row.number),
    extensionId: row.extensionId,
    trunkId: row.aplisayId,
    inUseByAgent: Boolean(row.instanceId),
    emergencyRecordState: row.emergencyRecordState,
  }));

  const connections = plain(await PhoneRegistration.findAll({
    where: { ...where, ...notADeviceLine },
    attributes: ['id'],
    transaction,
  }));

  // Only the agents that an extension names, as a type or as a destination.
  const instanceIds = new Set();
  for (const extension of extensions) {
    if (extension.instanceId) instanceIds.add(extension.instanceId);
    for (const { destination } of destinationsIn(extension.params)) {
      if (destination.kind === 'agent') instanceIds.add(destination.instanceId);
    }
  }
  const instances = instanceIds.size
    ? (await Instance.findAll({ where: { id: [...instanceIds], organisationId }, attributes: ['id', 'agentId', 'type'], transaction }))
      .map((row) => ({ id: row.id, agentId: row.agentId, runtime: row.type }))
    : [];

  return {
    organisation: organisation.get({ plain: true }),
    entries, extensions, members, phones, phonePeople, rules, lines, numbers, connections, instances,
  };
}
