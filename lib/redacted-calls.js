/**
 * Read-side helpers for redacted calls (lib/call-redaction.js). This module
 * imports no database, so call readers and their tests can use it freely.
 */
import { stepReady } from './schema-guards.js';

export function callRedactionReady() {
  return stepReady('callRedaction');
}

/** The 410 a worker write path gives for a redacted call. */
export const CALL_REDACTED = {
  error: 'This call was deleted, so nothing more is stored for it.',
  code: 'call_redacted',
};

/** A where clause that leaves out redacted calls. Empty before schema 78, when none can exist. */
export function notRedacted() {
  return callRedactionReady() ? { redactedAt: null } : {};
}
