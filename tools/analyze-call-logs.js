#!/usr/bin/env node
/**
 * Export call metadata and function_results transaction logs as JSON.
 * Each row includes callId, calledId, started_at, ended_at (ISO or null), date, time, functionResults.
 *
 * Filters (mutually exclusive):
 *   --called-id <fragment>  Match when calls.called_id contains this fragment (e.g. last digits of E.164).
 *   --agent-id <uuid>     Restrict to calls for that agent.
 *   (neither)            All calls in the time window (use --limit to cap rows).
 *
 * Calls with model_name 'bridged-transfer' are always excluded.
 * Only calls that have at least one transaction_logs row with type 'user' are included.
 *
 * Time window (required):
 *   --start <iso>  Inclusive lower bound on call.started_at (fallback: created_at if started_at null).
 *   --end <iso>    Exclusive upper bound (same column as start).
 *
 * After JSON on stdout, prints a summary on stderr: percentages of analysed calls
 * (1) with a completed transfer (status OK, reason "Transfer completed successfully"),
 * (2) with a failed transfer attempt (nested result status FAILED and a
 * transfer-related reason string in function_results), and (3) bounce rate: share of
 * calls with neither outcome (no transfer attempted, by those log signals).
 */
import dotenv from 'dotenv';
import path from 'path';
import commandLineArgs from 'command-line-args';
import { Op, Sequelize } from 'sequelize';

/** Calls using this model are omitted from analysis. */
const EXCLUDED_MODEL_NAME = 'bridged-transfer';

const optionDefinitions = [
  { name: 'path', alias: 'p', type: String },
  { name: 'start', type: String },
  { name: 'end', type: String },
  { name: 'called-id', type: String },
  { name: 'agent-id', type: String },
  { name: 'limit', alias: 'l', type: Number },
  { name: 'help', alias: 'h', type: Boolean },
];

const options = commandLineArgs(optionDefinitions);

let started;

function usage() {
  console.log(`Usage: ${path.basename(process.argv[1])} --start <iso> --end <iso> [filters] [-p envfile]

Options:
  -p, --path <file>   Dotenv file (default: .env in cwd)
  --start <iso>       Start of range (inclusive), e.g. 2026-03-01T00:00:00.000Z
  --end <iso>         End of range (exclusive)
  --called-id <str>   Match when calls.called_id contains this value (e.g. trailing digits)
  --agent-id <uuid>   Filter by calls.agent_id
  -l, --limit <n>     Max calls to return (optional; avoids huge exports)

Provide at most one of --called-id or --agent-id. If neither is set, every call
in the window is included (subject to --limit).

Calls with model_name "${EXCLUDED_MODEL_NAME}" are excluded.
Only calls with at least one transaction log of type 'user' are included.

After the JSON, stderr reports percentages: completed transfer, failed transfer
attempt, and bounce (no transfer attempted by those signals — see script header).`);
}

function parseData(data) {
  if (data == null) return data;
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

function splitDateTime(value) {
  if (!value) {
    return { date: null, time: null };
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return { date: null, time: null };
  }
  const iso = d.toISOString();
  const [date, rest] = iso.split('T');
  const time = rest ?? null;
  return { date, time };
}

function toIsoOrNull(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function serializeTransactionLog(log) {
  return {
    id: log.id,
    callId: log.callId,
    type: log.type,
    data: parseData(log.data),
    isFinal: log.isFinal,
    createdAt: log.createdAt?.toISOString?.() ?? log.createdAt,
    updatedAt: log.updatedAt?.toISOString?.() ?? log.updatedAt,
  };
}

const TRANSFER_OK_REASON = 'Transfer completed successfully';

/** @param {unknown} value */
function parseNestedResult(value) {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * True if this function_results `data` payload has any tool result whose
 * nested JSON includes status OK and the standard transfer-completed reason.
 * @param {unknown} data
 */
function functionResultsDataHasCompletedTransfer(data) {
  const rows = Array.isArray(data) ? data : data != null ? [data] : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const inner = parseNestedResult(row.result);
    if (
      inner &&
      typeof inner === 'object' &&
      inner.status === 'OK' &&
      inner.reason === TRANSFER_OK_REASON
    ) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Array<{ data?: unknown }>} functionResults
 */
function callHasCompletedTransfer(functionResults) {
  if (!Array.isArray(functionResults)) return false;
  for (const entry of functionResults) {
    if (entry && functionResultsDataHasCompletedTransfer(entry.data)) {
      return true;
    }
  }
  return false;
}

/** Narrow FAILED tool results to transfer/consult paths (see transfer-handler TransferResult). */
function reasonLooksLikeTransferFailure(reason) {
  if (reason == null) return false;
  const r = String(reason).toLowerCase();
  return (
    r.includes('transfer') ||
    r.includes('consult') ||
    r.includes('refer') ||
    r.includes('bridge') ||
    r.includes('warm') ||
    r.includes('finalize') ||
    r.includes('finalise') ||
    r.includes('sip ') ||
    r.includes('dial')
  );
}

/** @param {unknown} inner */
function isFailedTransferResult(inner) {
  if (!inner || typeof inner !== 'object') return false;
  const st = String(inner.status ?? '').toUpperCase();
  if (st !== 'FAILED') return false;
  if (inner.reason === TRANSFER_OK_REASON) return false;
  return reasonLooksLikeTransferFailure(inner.reason);
}

/**
 * True if any tool row's nested result is a transfer-style FAILED outcome.
 * @param {unknown} data
 */
function functionResultsDataHasFailedTransfer(data) {
  const rows = Array.isArray(data) ? data : data != null ? [data] : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const inner = parseNestedResult(row.result);
    if (isFailedTransferResult(inner)) return true;
  }
  return false;
}

/**
 * @param {Array<{ data?: unknown }>} functionResults
 */
function callHasFailedTransfer(functionResults) {
  if (!Array.isArray(functionResults)) return false;
  for (const entry of functionResults) {
    if (entry && functionResultsDataHasFailedTransfer(entry.data)) {
      return true;
    }
  }
  return false;
}

/** Any transfer outcome we detect in function_results (completed or failed attempt). */
function callHasTransferAttempt(functionResults) {
  return (
    callHasCompletedTransfer(functionResults) ||
    callHasFailedTransfer(functionResults)
  );
}

async function main() {
  if (options.help) {
    usage();
    process.exit(0);
  }

  if (!options.start || !options.end) {
    usage();
    process.exitCode = 1;
    throw new Error('Both --start and --end are required.');
  }

  const calledId = options['called-id'];
  const agentId = options['agent-id'];

  if (calledId && agentId) {
    process.exitCode = 1;
    throw new Error('Use only one of --called-id or --agent-id, not both.');
  }

  const start = new Date(options.start);
  const end = new Date(options.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    process.exitCode = 1;
    throw new Error('Invalid --start or --end date.');
  }
  if (start >= end) {
    process.exitCode = 1;
    throw new Error('--start must be before --end.');
  }

  const envPath = path.resolve(process.cwd(), options.path || '.env');
  dotenv.config({ path: envPath });

  const {
    Call,
    TransactionLog,
    stopDatabase,
    databaseStarted,
  } = await import('../lib/database.js');
  await databaseStarted;
  started = stopDatabase;

  const inTimeWindow = {
    [Op.or]: [
      {
        startedAt: {
          [Op.gte]: start,
          [Op.lt]: end,
        },
      },
      {
        startedAt: { [Op.is]: null },
        createdAt: {
          [Op.gte]: start,
          [Op.lt]: end,
        },
      },
    ],
  };

  const notBridgedTransferModel = {
    [Op.or]: [
      { modelName: { [Op.is]: null } },
      { modelName: { [Op.ne]: EXCLUDED_MODEL_NAME } },
    ],
  };

  const hasAtLeastOneUserTurn = {
    id: {
      [Op.in]: Sequelize.literal(
        `(SELECT DISTINCT tl.call_id FROM transaction_logs AS tl WHERE tl.type = 'user')`,
      ),
    },
  };

  let where;
  if (calledId) {
    where = {
      [Op.and]: [
        Sequelize.where(
          Sequelize.fn('STRPOS', Sequelize.col('called_id'), calledId),
          Op.gt,
          0,
        ),
        inTimeWindow,
        notBridgedTransferModel,
        hasAtLeastOneUserTurn,
      ],
    };
  } else if (agentId) {
    where = {
      [Op.and]: [
        { agentId },
        inTimeWindow,
        notBridgedTransferModel,
        hasAtLeastOneUserTurn,
      ],
    };
  } else {
    where = {
      [Op.and]: [inTimeWindow, notBridgedTransferModel, hasAtLeastOneUserTurn],
    };
  }

  const query = {
    where,
    attributes: ['id', 'calledId', 'agentId', 'startedAt', 'endedAt', 'createdAt'],
    order: [
      ['startedAt', 'ASC'],
      ['createdAt', 'ASC'],
    ],
  };
  if (options.limit != null && Number.isFinite(options.limit)) {
    query.limit = options.limit;
  }

  const calls = await Call.findAll(query);
  const ids = calls.map((c) => c.id);
  const summaryCalledIdClause =
    calledId != null && String(calledId).length > 0
      ? `called-id ${JSON.stringify(String(calledId))}; `
      : '';
  if (!ids.length) {
    process.stdout.write(`${JSON.stringify([], null, 2)}\n`);
    console.error(
      `Summary: ${summaryCalledIdClause}` +
        'analysed calls: 0; completed transfer: 0 (n/a); transfer requested but failed: 0 (n/a); bounce no transfer attempted: 0 (n/a)',
    );
    return;
  }

  const logs = await TransactionLog.findAll({
    where: {
      callId: { [Op.in]: ids },
      type: 'function_results',
    },
    order: [['createdAt', 'ASC']],
  });

  const byCall = new Map();
  for (const id of ids) {
    byCall.set(id, []);
  }
  for (const log of logs) {
    const list = byCall.get(log.callId);
    if (list) {
      list.push(serializeTransactionLog(log));
    }
  }

  const out = calls.map((call) => {
    const t = call.startedAt ?? call.createdAt;
    const { date, time } = splitDateTime(t);
    return {
      callId: call.id,
      calledId: call.calledId,
      started_at: toIsoOrNull(call.startedAt),
      ended_at: toIsoOrNull(call.endedAt),
      date,
      time,
      functionResults: byCall.get(call.id) ?? [],
    };
  });

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

  const total = out.length;
  const withCompletedTransfer = out.filter((row) =>
    callHasCompletedTransfer(row.functionResults),
  ).length;
  const withFailedTransfer = out.filter((row) =>
    callHasFailedTransfer(row.functionResults),
  ).length;
  const withNoTransferAttempt = out.filter(
    (row) => !callHasTransferAttempt(row.functionResults),
  ).length;
  const pctCompleted =
    total > 0 ? ((100 * withCompletedTransfer) / total).toFixed(2) : 'n/a';
  const pctFailed =
    total > 0 ? ((100 * withFailedTransfer) / total).toFixed(2) : 'n/a';
  const pctBounce =
    total > 0 ? ((100 * withNoTransferAttempt) / total).toFixed(2) : 'n/a';
  console.error(
    `Summary: ${summaryCalledIdClause}` +
      `analysed calls: ${total} (after filters; at least one user turn); ` +
      `completed transfer (OK / "${TRANSFER_OK_REASON}"): ${withCompletedTransfer} ` +
      `(${total > 0 ? `${pctCompleted}%` : pctCompleted}); ` +
      `transfer requested but failed (FAILED + transfer-related reason): ${withFailedTransfer} ` +
      `(${total > 0 ? `${pctFailed}%` : pctFailed}); ` +
      `bounce (no transfer attempted — no completed or failed signal above): ${withNoTransferAttempt} ` +
      `(${total > 0 ? `${pctBounce}%` : pctBounce})`,
  );
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (started) {
      await started();
    }
  });
