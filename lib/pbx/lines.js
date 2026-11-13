/**
 * Working out the lines of one phone. Pure: it reads nothing and writes
 * nothing. lib/pbx/snapshot.js builds its input and lib/pbx/reconcile.js
 * applies its output, so a dry run and a real write use the same code.
 */

// Only these types ring a phone, so only these take a key. A `connection`
// extension is dialled on the customer's own system, and `forward` and
// `agent` extensions send the call elsewhere.
export const RINGING_TYPES = new Set(['ring_all', 'hunt', 'queue']);

const get = (collection, key) => (collection instanceof Map ? collection.get(key) : collection?.[key]);

/**
 * @param {object} input
 * @param {{id: string, kind: string, capacity: number}} input.phone
 * @param {Array<{entryId: string, position: number}>} input.people  the people the phone rings for
 * @param {Map|object} input.owned     entryId -> that person's own extension
 * @param {Map|object} input.memberOf  entryId -> [{ extension, keyPosition }], shared extensions only
 * @returns {Array<object>} slots in key order: `{ position, kind: 'extension', extensionId }`,
 *   and on overflow a last `{ position, kind: 'other', covers: [extensionId] }`
 */
export function workOutLines({ phone, people = [], owned = new Map(), memberOf = new Map() }) {
  // An outside number has no lines.
  if (phone.kind === 'external') return [];

  const inOrder = [...people].sort((a, b) => a.position - b.position);
  const wanted = [];
  const seen = new Set();
  const want = (extension) => {
    if (!extension || !RINGING_TYPES.has(extension.type) || seen.has(extension.id)) return;
    seen.add(extension.id);
    wanted.push(extension.id);
  };

  // Owned extensions first, in the order of the people on the phone.
  for (const person of inOrder) want(get(owned, person.entryId));

  // Then shared extensions: person by person, each in that person's key order.
  // One already placed keeps its first position.
  for (const person of inOrder) {
    const memberships = [...(get(memberOf, person.entryId) || [])].sort((a, b) => {
      const byKey = (a.keyPosition ?? Infinity) - (b.keyPosition ?? Infinity);
      return byKey || String(a.extension.id).localeCompare(String(b.extension.id));
    });
    for (const membership of memberships) want(membership.extension);
  }

  const capacity = Math.max(0, Number(phone.capacity) || 0);
  const extensionSlot = (extensionId, index) => ({ position: index + 1, kind: 'extension', extensionId });
  if (wanted.length <= capacity) return wanted.map(extensionSlot);
  if (capacity === 0) return [];

  // Overflow: the last key takes calls for every extension that did not fit.
  const slots = wanted.slice(0, capacity - 1).map(extensionSlot);
  slots.push({ position: capacity, kind: 'other', covers: wanted.slice(capacity - 1) });
  return slots;
}

/**
 * How many people a phone may ring for: one fewer than its lines, and one on a
 * one-line phone. The count alone decides, so the last key is always free for
 * shared extensions and no later change can push a person's own extension
 * into the overflow line.
 */
export function maxPeople(capacity) {
  const lines = Math.max(0, Number(capacity) || 0);
  return lines <= 1 ? lines : lines - 1;
}

/** What makes a line the same line across a change: its extension, or being the overflow line. */
export function lineIdentity(lineOrSlot) {
  return lineOrSlot.kind === 'other' ? 'other' : lineOrSlot.extensionId;
}

const sameList = (a = [], b = []) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Compare a phone's current lines with the slots it should have.
 * `moved` and `coverChanged` are about kept lines only.
 */
export function diffLines(current = [], slots = []) {
  const currentById = new Map(current.map((line) => [lineIdentity(line), line]));
  const wantedById = new Map(slots.map((slot) => [lineIdentity(slot), slot]));
  const removed = current.filter((line) => !wantedById.has(lineIdentity(line)));
  const added = slots.filter((slot) => !currentById.has(lineIdentity(slot)));
  const kept = slots
    .filter((slot) => currentById.has(lineIdentity(slot)))
    .map((slot) => ({ line: currentById.get(lineIdentity(slot)), slot }));
  const moved = kept.filter(({ line, slot }) => line.position !== slot.position);
  const coverChanged = kept.some(({ line, slot }) => slot.kind === 'other' && !sameList(line.covers || [], slot.covers || []));
  return { added, removed, kept, moved, coverChanged, changed: Boolean(added.length || removed.length || moved.length || coverChanged) };
}

const cut = (text, length) => String(text ?? '').slice(0, Math.max(0, length)).trim();

/**
 * The label of a key. An owned line shows the owner's name and the number, and
 * a cut keeps the number: "Rob Parkinson 100" becomes "Rob P. 100", then "100".
 * A shared line shows the extension's name. The overflow line shows one word.
 */
export function lineLabel({ kind, number, name, personal, labelChars = 12, otherWord = 'Other' }) {
  if (kind === 'other') return cut(otherWord, labelChars);
  const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!personal) return cut(cleanName || number, labelChars);
  const full = `${cleanName} ${number}`.trim();
  if (full.length <= labelChars) return full;
  const parts = cleanName.split(' ').filter(Boolean);
  if (parts.length > 1) {
    const short = `${parts[0]} ${parts[parts.length - 1][0]}. ${number}`;
    if (short.length <= labelChars) return short;
  }
  return cut(number, labelChars);
}
