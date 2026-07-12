/**
 * Usage ledger recording helpers — the single choke point through which every
 * producer (the agent-db ingest endpoint, the in-process Node LLM models, the
 * Ultravox webhook) writes metered consumption into `usage_records`.
 *
 * See `lib/database.js` `UsageRecord` for the row model. Each call records one
 * meter — (technology, provider, detail, unit) — for a session, updating the
 * existing row in place when provisional totals are reflushed. A meter is
 * identified within a session by its `meterKey`, so repeated flushes converge on
 * a single row; `finalised` marks the count complete.
 *
 * Recording must never throw: a metering failure must not break a live call or a
 * chat turn, so all errors are caught and logged and the helpers return null.
 *
 * @module lib/usage
 */
import { UsageRecord, Sequelize } from './database.js';
import { costUsageRow } from './rates.js';
import defaultLogger from './logger.js';

/** usage_records.agent_id is a UUID column; anything else is unattributable. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record (or update) a single usage meter for a session.
 *
 * On first sighting the row is created with `quantity`. On a later flush for the
 * same (sessionId, meterKey): `mode:'set'` replaces the quantity with the new
 * cumulative total (idempotent — what the workers post), `mode:'increment'` adds
 * `quantity` as a delta (what the in-process Node path posts per turn).
 *
 * @param {object} params
 * @param {string} [params.sessionId] session grouping key; defaults to `callId`
 * @param {string} [params.callId] originating call id (null for text agents)
 * @param {string} [params.organisationId]
 * @param {string} [params.userId]
 * @param {string} [params.agentId]
 * @param {string} params.technology broad category ('llm'|'tts'|'stt'|'voice'|'function'|…)
 * @param {string} [params.provider] vendor ('anthropic'|'elevenlabs'|…)
 * @param {string} [params.detail] detailed model/tech name
 * @param {string} params.unit unit of measure ('input_tokens'|'characters'|'milliseconds'|…)
 * @param {number} [params.quantity=0] cumulative total (mode 'set') or delta (mode 'increment')
 * @param {boolean} [params.finalised=false] mark the meter final (sticky — never unset)
 * @param {object} [params.metadata]
 * @param {'set'|'increment'} [params.mode='set'] replace vs add to the stored quantity
 * @param {object} [params.log]
 * @returns {Promise<UsageRecord|null>}
 */
export async function recordUsage({
  sessionId,
  callId = null,
  organisationId = null,
  userId = null,
  agentId = null,
  technology,
  provider = null,
  detail = null,
  unit,
  quantity = 0,
  finalised = false,
  metadata = null,
  mode = 'set',
  log = defaultLogger,
} = {}) {
  sessionId = sessionId || callId;
  if (!sessionId || !technology || !unit) {
    log.warn({ sessionId, technology, unit }, 'recordUsage: missing sessionId/technology/unit; skipping');
    return null;
  }
  // usage_records.agent_id is a UUID column, but BUILTIN agents chat too
  // ('builtin:set-builder') — a non-UUID id must degrade to an unattributed
  // row, not throw the whole meter reading away (builtin builder sessions
  // metered NOTHING before this). The original id still discriminates the
  // meterKey below, so per-agent meters within a session stay distinct.
  const agentIdColumn = agentId && UUID_RE.test(String(agentId)) ? agentId : null;
  const meterKey = UsageRecord.meterKey({ agentId, technology, provider, detail, unit });
  const qty = Math.trunc(Number(quantity) || 0);

  const apply = () => UsageRecord.sequelize.transaction(async (transaction) => {
    const [record, created] = await UsageRecord.findOrCreate({
      where: { sessionId, meterKey },
      defaults: {
        sessionId, meterKey, callId, organisationId, userId,
        agentId: agentIdColumn,
        technology, provider, detail, unit,
        quantity: qty,
        finalised: !!finalised,
        metadata,
      },
      transaction,
    });
    if (created) {
      return record;
    }
    // Existing meter for this session: update in place.
    if (mode === 'increment' && qty) {
      await record.increment('quantity', { by: qty, transaction });
    }
    const updates = {};
    if (mode === 'set') updates.quantity = qty;
    if (finalised) updates.finalised = true;            // sticky-OR: never unset
    // Backfill identity/context that may only have arrived on a later flush.
    if (callId && !record.callId) updates.callId = callId;
    if (organisationId && !record.organisationId) updates.organisationId = organisationId;
    if (userId && !record.userId) updates.userId = userId;
    if (agentIdColumn && !record.agentId) updates.agentId = agentIdColumn;
    if (metadata) updates.metadata = metadata;
    if (Object.keys(updates).length) {
      await record.update(updates, { transaction });
    }
    await record.reload({ transaction });
    return record;
  });

  // Cost-at-finalisation: a finalised row is valued + settled exactly once
  // (idempotent, never-throw, isolated from the meter write above so a costing
  // failure can never become a metering failure). Provisional flushes aren't costed.
  const costed = async (record) => {
    if (record?.finalised) await costUsageRow(record, { log });
    return record;
  };

  try {
    return await costed(await apply());
  } catch (err) {
    // Lost a findOrCreate race against a concurrent flush for the same meter;
    //  the row now exists, so retry once and the update path takes over.
    if (err instanceof Sequelize.UniqueConstraintError) {
      try {
        return await costed(await apply());
      } catch (err2) {
        log.error(err2, 'recordUsage retry failed');
        return null;
      }
    }
    log.error(err, 'recordUsage failed');
    return null;
  }
}

// Maps the normalised LLM usage shape onto ledger units. Only non-zero counts
//  produce a row, so a provider that doesn't report cache tokens simply omits them.
const TOKEN_UNITS = [
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_tokens'],
  ['cacheWriteTokens', 'cache_write_tokens'],
];

/**
 * Record LLM token usage as one ledger row per non-zero token unit. Keeps the
 * per-provider model files (anthropic/openai/vertex/…) from each having to know
 * the ledger shape.
 *
 * @param {object} params identity fields plus `provider`, `model`, and any of
 *   `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`.
 * @returns {Promise<Array<UsageRecord|null>>}
 */
export async function recordLlmTokens({
  sessionId, callId, organisationId, userId, agentId,
  provider, model,
  inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0,
  mode = 'increment', finalised = false, metadata = null, log = defaultLogger,
} = {}) {
  const counts = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  const results = [];
  for (const [key, unit] of TOKEN_UNITS) {
    const quantity = Math.trunc(Number(counts[key]) || 0);
    if (!quantity) continue;
    results.push(await recordUsage({
      sessionId, callId, organisationId, userId, agentId,
      technology: 'llm', provider, detail: model, unit,
      quantity, mode, finalised, metadata, log,
    }));
  }
  return results;
}

/**
 * Record the token usage returned by `runSubagent` (an array of per-agent
 * entries — its own plus any bubbled-up nested subagents) against a session.
 * Used at the text-agent boundaries (the invoke / agent-db subagent endpoints
 * and the chat session), which own the session id.
 *
 * Increments by default so repeated invocations within the same session/call
 * accumulate rather than overwrite.
 *
 * @param {object} params
 * @param {string} [params.sessionId]
 * @param {string} [params.callId]
 * @param {string} [params.organisationId]
 * @param {string} [params.userId]
 * @param {Array<object>} [params.usage] entries from runSubagent's result.usage
 * @param {boolean} [params.finalised=false]
 * @param {object} [params.log]
 * @returns {Promise<Array<UsageRecord|null>>}
 */
export async function recordSubagentUsage({
  sessionId, callId = null, organisationId = null, userId = null,
  usage = [], finalised = false, log = defaultLogger,
} = {}) {
  const results = [];
  for (const entry of usage || []) {
    if (!entry) continue;
    const recorded = await recordLlmTokens({
      sessionId, callId, organisationId, userId,
      agentId: entry.agentId, provider: entry.provider, model: entry.model,
      inputTokens: entry.inputTokens, outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens, cacheWriteTokens: entry.cacheWriteTokens,
      mode: 'increment', finalised, log,
    });
    results.push(...recorded);
  }
  return results;
}

/**
 * Record an array of meter readings (used by the agent-db ingest endpoint).
 * Sequential to avoid lock contention on the same meter rows; each record's own
 * failure is isolated (returns null for that entry).
 *
 * @param {Array<object>} records recordUsage param objects
 * @param {object} [opts]
 * @returns {Promise<Array<UsageRecord|null>>}
 */
export async function recordUsageBatch(records = [], { log = defaultLogger } = {}) {
  const out = [];
  for (const record of records) {
    out.push(await recordUsage({ ...record, log }));
  }
  return out;
}

/**
 * Mark every not-yet-finalised meter for a session as finalised. The
 * transaction-end signal for producers that accumulate in place and never set
 * `finalised` per-row — notably interactive text-chat, whose only end signal is
 * the websocket close. Best-effort; never throws.
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {object} [opts.log]
 * @returns {Promise<number>} number of rows finalised
 */
export async function finaliseSession(sessionId, { log = defaultLogger } = {}) {
  if (!sessionId) return 0;
  try {
    const [count] = await UsageRecord.update(
      { finalised: true },
      { where: { sessionId, finalised: false } },
    );
    // Cost the session's finalised-but-uncosted rows (those this call flipped, plus
    // any earlier per-row finalisations not yet valued). Per-row never-throw; rows
    // already costed (matched/no_rate/errored) are skipped — the sweep retries those.
    const uncosted = await UsageRecord.findAll({ where: { sessionId, finalised: true, costStatus: null } });
    for (const row of uncosted) {
      await costUsageRow(row, { log });
    }
    return count || 0;
  } catch (err) {
    log.error(err, 'finaliseSession failed');
    return 0;
  }
}

export default recordUsage;
