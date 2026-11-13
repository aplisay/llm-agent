/**
 * Turns the worked-out lines of each phone into `lines` rows and SIP accounts.
 * The only writer of `lines`, and the only writer of `phone_registrations`
 * rows of kind 'device'.
 *
 * It runs inside the transaction of the write that changed the directory. In
 * a dry run it writes nothing and reports the same effect.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { Phone, Device, Line, PhoneChange, PhoneRegistration } from '../database.js';
import { registrarRealm } from '../registrar-accounts.js';
import { workOutLines, diffLines, lineIdentity } from './lines.js';
import { indexSnapshot, linesInput, labelFor } from './snapshot.js';
import { loadSnapshot } from './store.js';
import { PbxError } from './errors.js';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// Positions are unique on a phone, so lines that swap keys pass through a range nothing uses.
const POSITION_PARK = 1000;

const randomString = (alphabet, length) => Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');

/**
 * The name desk phones register to, and so the digest realm of every line
 * account: PBX_REGISTRAR_DOMAIN, else the deployment's registrar name.
 */
export function pbxRegistrarDomain(env = process.env) {
  const host = String(env.PBX_REGISTRAR_DOMAIN || '').trim().toLowerCase();
  if (host) return HOSTNAME_RE.test(host) ? host : null;
  return registrarRealm(env);
}

/** A SIP account for one line of a desk phone. Random credentials, never chosen by anyone. */
async function createLineAccount({ organisationId, name, transaction }) {
  const registrar = pbxRegistrarDomain();
  if (!registrar) {
    throw new PbxError(503, 'registrar_unavailable',
      'Phone lines are not available on this deployment (PBX_REGISTRAR_DOMAIN is not configured)');
  }
  // 75 random bits: a clash with the unique index is not handled, it would fail the write.
  return PhoneRegistration.create({
    mode: 'registrar',
    kind: 'device',
    organisationId,
    registrar,
    username: `l${randomString(BASE32, 15)}`,
    password: randomString(PASSWORD_ALPHABET, 32),
    handler: 'pbx',
    name,
    // Unlike a PBX account there is no activate step: nobody types these in.
    status: 'active',
    state: 'initial',
  }, { transaction });
}

const slotView = (index, phone, lineOrSlot, otherWord) => ({
  key: lineOrSlot.position,
  kind: lineOrSlot.kind,
  ...(lineOrSlot.kind === 'other'
    ? { covers: lineOrSlot.covers || [] }
    : { extensionId: lineOrSlot.extensionId }),
  label: labelFor(index, phone, lineOrSlot, otherWord),
  lineNumber: lineOrSlot.lineNumber ?? null,
});

const identityView = (lineOrSlot) => (lineOrSlot.kind === 'other' ? { kind: 'other' } : { extensionId: lineOrSlot.extensionId });

/** The before and after of one phone, as the effect document shows it. */
function phoneEffect(index, phone, current, slots, diff, otherWord) {
  const numberOf = new Map(current.map((line) => [lineIdentity(line), line.lineNumber]));
  const after = slots.map((slot) => ({ ...slot, lineNumber: numberOf.get(lineIdentity(slot)) ?? null }));
  const people = (index.peopleByPhone.get(phone.id) || [])
    .map((person) => ({ entryId: person.entryId, name: index.entries.get(person.entryId)?.name ?? '' }));
  const withAccounts = phone.kind === 'deskphone';
  return {
    phoneId: phone.id,
    label: phone.label,
    kind: phone.kind,
    people,
    before: current.map((line) => slotView(index, phone, line, otherWord)),
    after: after.map((slot) => slotView(index, phone, slot, otherWord)),
    added: diff.added.map((slot) => ({ key: slot.position, ...identityView(slot) })),
    removed: diff.removed.map((line) => ({ key: line.position, ...identityView(line) })),
    moved: diff.moved.map(({ line, slot }) => ({ ...identityView(slot), from: line.position, to: slot.position })),
    sipAccounts: { create: withAccounts ? diff.added.length : 0, remove: withAccounts ? diff.removed.length : 0 },
    resync: 'none',
    warnings: [],
  };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function summarise(phones) {
  if (!phones.length) return 'No phone changes.';
  const added = phones.reduce((sum, phone) => sum + phone.added.length, 0);
  const removed = phones.reduce((sum, phone) => sum + phone.removed.length, 0);
  const moved = phones.reduce((sum, phone) => sum + phone.moved.length, 0);
  const on = (list) => `on ${plural(new Set(list.map((phone) => phone.phoneId)).size, 'phone')}`;
  const parts = [];
  if (added) parts.push(`Adds ${plural(added, 'line')} ${on(phones.filter((phone) => phone.added.length))}.`);
  if (removed) parts.push(`Removes ${plural(removed, 'line')} ${on(phones.filter((phone) => phone.removed.length))}.`);
  if (moved) parts.push(`Moves ${plural(moved, 'key')} ${on(phones.filter((phone) => phone.moved.length))}.`);
  if (!parts.length) parts.push(`Updates ${plural(phones.length, 'phone')}.`);
  return parts.join(' ');
}

/** The effect document for a list of per-phone effects. */
export function effectOf(phones, extra = {}) {
  const users = new Map();
  for (const phone of phones) for (const person of phone.people) users.set(person.entryId, person);
  return {
    phones,
    phonesAffected: phones.length,
    linesAdded: phones.reduce((sum, phone) => sum + phone.added.length, 0),
    linesRemoved: phones.reduce((sum, phone) => sum + phone.removed.length, 0),
    keysMoved: phones.reduce((sum, phone) => sum + phone.moved.length, 0),
    affectedUsers: [...users.values()],
    // Filled when a price for an extension exists.
    charges: { add: [], remove: [] },
    dependents: { numbers: [], destinationOf: [], agentsTransferringHere: [] },
    summary: summarise(phones),
    ...extra,
  };
}

async function applyToPhone({ index, phone, current, slots, diff, transaction }) {
  await Phone.findByPk(phone.id, { attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
  const organisationId = index.organisation.id;

  for (const line of diff.removed) {
    await Line.destroy({ where: { id: line.id }, transaction });
    if (line.endpointId) await PhoneRegistration.destroy({ where: { id: line.endpointId }, transaction });
  }

  for (const { line } of diff.moved) {
    await Line.update({ position: line.position + POSITION_PARK }, { where: { id: line.id }, transaction });
  }
  for (const { line, slot } of diff.kept) {
    const coversChanged = slot.kind === 'other' && JSON.stringify(line.covers || []) !== JSON.stringify(slot.covers || []);
    if (line.position !== slot.position || coversChanged) {
      await Line.update(
        { position: slot.position, ...(slot.kind === 'other' ? { covers: slot.covers } : {}) },
        { where: { id: line.id }, transaction },
      );
    }
  }

  const numbers = new Map(current.map((line) => [lineIdentity(line), line.lineNumber]));
  for (const slot of diff.added) {
    const endpoint = phone.kind === 'deskphone'
      ? await createLineAccount({ organisationId, name: `${phone.label}: ${labelFor(index, phone, slot)}`.slice(0, 255), transaction })
      : null;
    const line = await Line.create({
      organisationId,
      phoneId: phone.id,
      position: slot.position,
      kind: slot.kind,
      extensionId: slot.kind === 'extension' ? slot.extensionId : null,
      covers: slot.kind === 'other' ? slot.covers : null,
      endpointId: endpoint?.id ?? null,
    }, { transaction });
    // The line number comes from the sequence, so read the row back.
    await line.reload({ transaction });
    numbers.set(lineIdentity(slot), line.lineNumber);
  }
  return numbers;
}

/**
 * Work out the lines of every phone of an organisation again and apply what
 * differs. Call it after any write that can change who a phone rings for.
 *
 * @param {object} args
 * @param {string} args.organisationId
 * @param {object} args.transaction
 * @param {boolean} [args.dryRun]         report only, write nothing
 * @param {object} args.cause             `{ kind, entryId?, extensionId?, phoneId?, detail? }`
 * @param {object} args.actor             `{ kind, userId }`
 * @param {string} [args.requestId]       one id for every phone this write touches
 * @param {Set<string>} [args.relabelled] extensions whose label changed: their phones are recorded as changed
 * @returns {Promise<object>} the effect document
 */
export async function restack({
  organisationId, transaction, dryRun = false, cause, actor, requestId = randomUUID(), relabelled = new Set(), otherWord,
}) {
  const snapshot = await loadSnapshot(organisationId, { transaction });
  if (!snapshot) return effectOf([]);
  const index = indexSnapshot(snapshot);
  const effects = [];

  for (const phone of snapshot.phones) {
    const current = index.linesByPhone.get(phone.id) || [];
    const slots = workOutLines(linesInput(index, phone));
    const diff = diffLines(current, slots);
    const labelsChanged = slots.some((slot) => slot.kind === 'extension' && relabelled.has(slot.extensionId));
    if (!diff.changed && !labelsChanged) continue;

    const effect = phoneEffect(index, phone, current, slots, diff, otherWord);
    if (!dryRun) {
      const numbers = await applyToPhone({ index, phone, current, slots, diff, transaction });
      effect.after = effect.after.map((slot, i) => ({ ...slot, lineNumber: numbers.get(lineIdentity(slots[i])) ?? slot.lineNumber }));
      await PhoneChange.create({
        organisationId,
        phoneId: phone.id,
        requestId,
        cause: diff.changed ? cause : { ...cause, kind: 'labels' },
        before: effect.before,
        after: effect.after,
        actorKind: actor?.kind || 'system',
        actorUserId: actor?.userId ?? null,
        resync: effect.resync,
      }, { transaction });
      if (phone.deviceId) {
        const device = await Device.findByPk(phone.deviceId, { transaction });
        if (device) {
          device.configVersion += 1;
          // A phone that has never fetched its settings is still waiting, not updating.
          if (device.fetchedVersion != null) device.provisioningState = 'updating';
          await device.save({ transaction });
        }
      }
    }
    effects.push(effect);
  }
  return effectOf(effects);
}

/**
 * Remove every line of one phone, with its SIP accounts. For a phone that is
 * being removed, which restack no longer sees.
 */
export async function removeLinesOfPhone({ phoneId, transaction }) {
  const lines = await Line.findAll({ where: { phoneId }, transaction });
  for (const line of lines) {
    await line.destroy({ transaction });
    if (line.endpointId) await PhoneRegistration.destroy({ where: { id: line.endpointId }, transaction });
  }
  return lines.length;
}
