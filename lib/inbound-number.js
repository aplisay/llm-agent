/**
 * The `where` that finds the row for a call in to a number: by number and
 * trunk. The agent workers' lookup and call control's use this one function,
 * so both find the same row.
 *
 * `trunkId` may hold several candidates separated by ";". With none, the
 * lookup is by number alone.
 */
export function inboundNumberWhere(number, trunkId) {
  const normalised = String(number).replace(/^\+/, '');
  const candidates = trunkId ? String(trunkId).split(';') : [];
  return candidates.length ? { number: normalised, aplisayId: candidates } : { number: normalised };
}
