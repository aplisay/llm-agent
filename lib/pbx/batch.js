/**
 * The pure parts of the directory batch (`POST /directory/batch`). The writes
 * themselves are in lib/pbx/directory.js.
 */
import { PbxError } from './errors.js';
import { can } from '../auth/permissions.js';

export const MAX_BATCH_OPS = 500;

export const BATCH_OPS = [
  'entry.create', 'entry.update', 'entry.delete', 'entry.restore',
  'extension.create', 'extension.update', 'extension.delete', 'extension.restore',
  'member.add', 'member.remove',
  'keyOrder.set', 'huntOrder.set',
];

/** The crawler's key. Its role is pinned on the key, so either says it. */
export const isKnowledgeService = (user) => user?.role === 'knowledgeService' || user?._roleRestriction === 'knowledgeService';

/** A principal that may write as the crawl: one that reads every organisation and has none of its own. */
export const mayActAsCrawl = (user) => can(user, 'directory', 'readAll') && user?.organisationId == null;

/** Who a batch says made it. `assistant` is the builder agent. */
export const BATCH_ACTORS = { user: 'user', assistant: 'builder', import: 'import', crawl: 'crawl' };

/** The crawl adds and updates entries, and gives them extensions on the customer's own phone system. Nothing else. */
export function CRAWL_OPS(op) {
  if (op.op === 'entry.create' || op.op === 'entry.update') return true;
  return op.op === 'extension.create' && (op.extension?.type ?? 'connection') === 'connection';
}

/** A batch with a refused op. `results` has one result for each op up to and including that one. */
export class BatchError extends PbxError {
  constructor(results) {
    super(400, 'batch_failed', 'Nothing was changed. One change in the batch was refused.');
    this.results = results;
  }

  body() {
    return { error: this.message, code: this.code, results: this.results };
  }
}

const REF = /^\$([A-Za-z0-9_-]{1,64})$/;

/** A copy of the op with each `"$name"` of an earlier op's `ref` put back as that row's id. */
export function resolveRefs(value, refs) {
  if (typeof value === 'string') {
    const match = REF.exec(value);
    return match && refs.has(match[1]) ? refs.get(match[1]) : value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, refs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveRefs(item, refs)]));
  }
  return value;
}

/** What a phone's change record says caused it, for a batch of one op. */
export function causeOfOp(op) {
  switch (op?.op) {
    case 'entry.create': return { kind: 'entry_created' };
    case 'entry.update': return { kind: 'labels', entryId: op.id };
    case 'entry.delete': return { kind: 'entry_removed', entryId: op.id };
    case 'entry.restore': return { kind: 'entry_restored', entryId: op.id };
    case 'extension.create': return { kind: 'extension_created' };
    case 'extension.update': return { kind: 'labels', extensionId: op.id };
    case 'extension.delete': return { kind: 'extension_removed', extensionId: op.id };
    case 'extension.restore': return { kind: 'extension_restored', extensionId: op.id };
    case 'member.add': return { kind: 'member_added', extensionId: op.extensionId, entryId: op.entryId };
    case 'member.remove': return { kind: 'member_removed', extensionId: op.extensionId, entryId: op.entryId };
    case 'keyOrder.set': return { kind: 'key_order', entryId: op.entryId };
    case 'huntOrder.set': return { kind: 'member_added', extensionId: op.extensionId };
    default: return { kind: 'batch' };
  }
}
