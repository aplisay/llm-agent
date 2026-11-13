/**
 * The directory of one organisation as plain data, and look-ups over it. Pure.
 * lib/pbx/store.js loads a snapshot from the database. The line working-out
 * and the ring plan both read it through indexSnapshot.
 *
 * A snapshot holds live rows only: nothing soft-deleted or removed, and
 * nothing that hangs off such a row.
 *
 *   organisation  { id, capabilities, mainNumber, busyStatusVisible }
 *   entries       [{ id, kind, name }]
 *   extensions    [{ id, number, type, entryId, connectionId, instanceId, forwardTo, params, outboundNumber }]
 *   members       [{ extensionId, entryId, huntPosition, keyPosition }]
 *   phones        [{ id, kind, label, capacity, labelChars, number, ringDelay, shows, keyToAnswer }]
 *   phonePeople   [{ phoneId, entryId, position }]
 *   rules         [{ phoneId, appliesTo, extensionIds, schedule, action, enabled }]
 *   lines         [{ id, phoneId, position, kind, extensionId, covers, lineNumber,
 *                    endpoint: { id, username, registrar, registered, lastSeenAt } | null }]
 *   numbers       [{ number: '+44…', extensionId, trunkId }]   the organisation's numbers
 *   connections   [{ id }]                                      its registration connections
 *   instances     [{ id, agentId, runtime }]                    optional, for agent destinations
 */
import { lineLabel } from './lines.js';

const push = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

export function indexSnapshot(snapshot) {
  const index = {
    organisation: snapshot.organisation,
    entries: new Map((snapshot.entries || []).map((entry) => [entry.id, entry])),
    extensions: new Map(),
    extensionByEntry: new Map(),
    extensionByNumber: new Map(),
    membersByExtension: new Map(),
    membershipsByEntry: new Map(),
    phones: new Map((snapshot.phones || []).map((phone) => [phone.id, phone])),
    peopleByPhone: new Map(),
    phonesByEntry: new Map(),
    rulesByPhone: new Map(),
    linesByPhone: new Map(),
    lineById: new Map(),
    lineByNumber: new Map(),
    numbers: snapshot.numbers || [],
    numbersByExtension: new Map(),
    connections: snapshot.connections || [],
    instances: new Map((snapshot.instances || []).map((instance) => [instance.id, instance])),
  };

  for (const extension of snapshot.extensions || []) {
    // An extension whose entry is gone is gone with it.
    if (extension.entryId && !index.entries.has(extension.entryId)) continue;
    index.extensions.set(extension.id, extension);
    index.extensionByNumber.set(extension.number, extension);
    if (extension.entryId) index.extensionByEntry.set(extension.entryId, extension);
  }

  for (const member of snapshot.members || []) {
    const extension = index.extensions.get(member.extensionId);
    if (!extension || !index.entries.has(member.entryId)) continue;
    push(index.membersByExtension, extension.id, member);
    // The owner's own row is not a shared membership.
    if (extension.entryId !== member.entryId) {
      push(index.membershipsByEntry, member.entryId, { extension, keyPosition: member.keyPosition });
    }
  }
  for (const list of index.membersByExtension.values()) list.sort((a, b) => a.huntPosition - b.huntPosition);
  for (const list of index.membershipsByEntry.values()) {
    list.sort((a, b) => (a.keyPosition ?? Infinity) - (b.keyPosition ?? Infinity)
      || String(a.extension.id).localeCompare(String(b.extension.id)));
  }

  for (const person of snapshot.phonePeople || []) {
    const phone = index.phones.get(person.phoneId);
    if (!phone || !index.entries.has(person.entryId)) continue;
    push(index.peopleByPhone, phone.id, person);
    push(index.phonesByEntry, person.entryId, phone);
  }
  for (const list of index.peopleByPhone.values()) list.sort((a, b) => a.position - b.position);

  for (const rule of snapshot.rules || []) {
    if (index.phones.has(rule.phoneId)) push(index.rulesByPhone, rule.phoneId, rule);
  }

  for (const line of snapshot.lines || []) {
    if (!index.phones.has(line.phoneId)) continue;
    push(index.linesByPhone, line.phoneId, line);
    index.lineById.set(line.id, line);
    index.lineByNumber.set(Number(line.lineNumber), line);
  }
  for (const list of index.linesByPhone.values()) list.sort((a, b) => a.position - b.position);

  for (const number of index.numbers) {
    if (number.extensionId) push(index.numbersByExtension, number.extensionId, number.number);
  }
  return index;
}

/** The extension a person owns, or undefined. A team's or service's extension is shared, not owned. */
export function ownedExtension(index, entryId) {
  return index.entries.get(entryId)?.kind === 'person' ? index.extensionByEntry.get(entryId) : undefined;
}

/** True when the extension belongs to a person. */
export function isPersonal(index, extension) {
  return Boolean(extension?.entryId) && index.entries.get(extension.entryId)?.kind === 'person';
}

/** The input of workOutLines for one phone. */
export function linesInput(index, phone) {
  const people = index.peopleByPhone.get(phone.id) || [];
  const owned = new Map();
  const memberOf = new Map();
  for (const person of people) {
    const own = ownedExtension(index, person.entryId);
    if (own) owned.set(person.entryId, own);
    memberOf.set(person.entryId, index.membershipsByEntry.get(person.entryId) || []);
  }
  return { phone: { id: phone.id, kind: phone.kind, capacity: phone.capacity }, people, owned, memberOf };
}

/** The label of a line or slot on a phone. */
export function labelFor(index, phone, lineOrSlot, otherWord = 'Other') {
  if (lineOrSlot.kind === 'other') return lineLabel({ kind: 'other', labelChars: phone.labelChars, otherWord });
  const extension = index.extensions.get(lineOrSlot.extensionId);
  if (!extension) return '';
  return lineLabel({
    kind: 'extension',
    number: extension.number,
    name: index.entries.get(extension.entryId)?.name ?? extension.number,
    personal: isPersonal(index, extension),
    labelChars: phone.labelChars,
  });
}

/**
 * The number an extension shows on calls out, and where it comes from: its
 * outbound number, else its only routed number, else the organisation's main
 * number.
 */
export function shownNumber(index, extension) {
  if (!extension) return { number: null, source: null };
  if (extension.outboundNumber) return { number: extension.outboundNumber, source: 'outbound' };
  const routed = index.numbersByExtension.get(extension.id) || [];
  if (routed.length === 1) return { number: routed[0], source: 'only' };
  if (index.organisation?.mainNumber) return { number: index.organisation.mainNumber, source: 'main' };
  return { number: null, source: null };
}

/** The line on a phone that carries an extension: its own line, or the overflow line that covers it. */
export function lineForExtension(index, phoneId, extensionId) {
  const lines = index.linesByPhone.get(phoneId) || [];
  return lines.find((line) => line.kind === 'extension' && line.extensionId === extensionId)
    || lines.find((line) => line.kind === 'other' && (line.covers || []).includes(extensionId))
    || null;
}

/** The extension a line makes calls as: its own, or for the overflow line the first user's own. */
export function callingExtension(index, line) {
  if (line.kind === 'extension') return index.extensions.get(line.extensionId);
  const first = (index.peopleByPhone.get(line.phoneId) || [])[0];
  return first ? ownedExtension(index, first.entryId) : undefined;
}
