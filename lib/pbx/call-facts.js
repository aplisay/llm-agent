/**
 * The facts call control keeps on a phone system call (`metadata.pbx`) that the
 * calls routes show. The names are call control's (RECORDS.md in callctl).
 * Anything else under `metadata.pbx` is stored and not shown.
 *
 * Needs no database.
 *
 * @module lib/pbx/call-facts
 */
import { Sequelize } from 'sequelize';

export const SHOWN_PBX_FACTS = Object.freeze([
  // The call.
  'direction', 'extensionId', 'extensionNumber', 'extensionName',
  'fromLineId', 'fromLineNumber', 'fromPhoneId', 'fromExtensionNumber',
  // An emergency call.
  'presentNumber', 'addressState', 'numberFrom',
  // A leg.
  'kind', 'keyToAnswer', 'keyPressedAt', 'entryId', 'phoneId', 'phoneLabel', 'lineId', 'lineNumber', 'key', 'number',
  // How it ended, written by the end route.
  'endReason', 'answered',
]);

const SCALAR = new Set(['string', 'number', 'boolean']);

/** A column for a calls query: `metadata.pbx` of a phone system call, null for any other call. */
export const PBX_FACTS_COLUMN = Object.freeze([
  Sequelize.literal('(CASE WHEN "Call"."platform" = \'pbx\' THEN "Call"."metadata"->\'pbx\' END)'),
  'pbxFacts',
]);

/** The shown keys of a stored `metadata.pbx`, with a plain value. */
export function shownPbxFacts(stored) {
  const facts = {};
  for (const key of SHOWN_PBX_FACTS) if (SCALAR.has(typeof stored?.[key])) facts[key] = stored[key];
  return facts;
}

/** A call as the routes send it: `pbxFacts` from PBX_FACTS_COLUMN becomes `metadata.pbx`. */
export function withPbxFacts(row) {
  const { pbxFacts, ...rest } = row;
  if (!pbxFacts || typeof pbxFacts !== 'object' || Array.isArray(pbxFacts)) return rest;
  return { ...rest, metadata: { pbx: shownPbxFacts(pbxFacts) } };
}
