/**
 * A call event as the calls routes show it. The `data` keys are call control's
 * (RECORDS.md in callctl). Any other key it stores, such as the engine's own
 * leg ids or error text, is not shown.
 *
 * Needs no database.
 *
 * @module lib/pbx/call-event-view
 */
export const SHOWN_EVENT_DATA = Object.freeze([
  'party', 'kind', 'entryId', 'phoneId', 'phoneLabel', 'lineId', 'lineNumber', 'key', 'number',
  'presentNumber', 'reason', 'code', 'action', 'tracks', 'try',
]);

const SCALAR = new Set(['string', 'number', 'boolean']);

/** One stored event `{ id, type, at, data }`, with only the shown `data` keys. */
export function shownEvent({ id, type, at, data } = {}) {
  const shown = {};
  for (const key of SHOWN_EVENT_DATA) if (SCALAR.has(typeof data?.[key])) shown[key] = data[key];
  return { id, type, at, data: shown };
}
