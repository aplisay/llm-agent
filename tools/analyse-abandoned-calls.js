#!/usr/bin/env node
/**
 * Fetch a list of abandoned calls from a URL, then query the LLM Agent /calls API
 * in a padded time window and correlate each abandoned row to a call by callerId
 * and fuzzy matched start time. For each correlated call, fetch /calls/{callId}/logs
 * and emit an English classification:
 * - Caller didn't speak (no user turn)
 * - transfer claimed to complete
 * - transfer attempted but failed
 * - no transfer attempt (investigate)
 * - unknown
 *
 * Output is plain text (one line per abandoned row) to stdout.
 */
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import axios from 'axios';
import commandLineArgs from 'command-line-args';

const optionDefinitions = [
  { name: 'url', alias: 'u', type: String },
  { name: 'server', alias: 's', type: String, defaultValue: 'https://llm-agent.aplisay.com' },
  { name: 'key', alias: 'k', type: String, defaultValue: process.env.API_KEY },
  { name: 'padMinutes', type: Number, defaultValue: 2 },
  // Increased default tolerance to account for pre-announcement offset.
  { name: 'toleranceMs', type: Number, defaultValue: 180000 },
  { name: 'limitCalls', type: Number, defaultValue: 1100 },
  { name: 'debug-correlation', type: Boolean, defaultValue: false },
  { name: 'debug-correlation-limit', type: Number, defaultValue: 8 },
  // Values:
  // - (unset/false): normal output
  // - (flag present with no value): defaults to "all"
  // - "all": include condensed transcript for all correlated calls
  // - "no-transfer": only print transcript for calls marked "no transfer attempt (investigate)"
  // - "transfer-fail": only print transcript for calls where a transfer was attempted (success or fail)
  //
  // Note: when type is String, `--verbose` parses as { verbose: null }.
  { name: 'verbose', alias: 'v', type: String, defaultValue: null },
  { name: 'help', alias: 'h', type: Boolean, defaultValue: false },
];

const options = commandLineArgs(optionDefinitions);

function usage() {
  console.log(`Usage: ${path.basename(process.argv[1])} [options]

Options:
  -u, --url <url>            Abandoned calls URL (required)
  -s, --server <url>         LLM Agent server (default: https://llm-agent.aplisay.com)
  -k, --key <token>          API key (default: API_KEY env var)
  --padMinutes <n>           Minutes padding before/after abandoned window (default: 2)
  --toleranceMs <ms>         Max start-time delta for correlation (default: 180000)
  --limitCalls <n>           Cap calls pulled from /calls (keeps most recent; default: 1100)
  --debug-correlation        On correlation failure, print considered candidates (stderr)
  --debug-correlation-limit  Max candidates to show (default: 8)
  -v, --verbose[=<mode>]     Print condensed transcript (main call lines + summary always print).
                            Modes: all | no-transfer | transfer-fail
  -h, --help                 Show help
`);
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

function callerMatches(abandonedCli, callCallerId) {
  const a = digitsOnly(abandonedCli);
  const b = digitsOnly(callCallerId);
  if (!a || !b) return false;
  if (a === b) return true;
  // Allow trunk formats by matching on suffix.
  const minSuffix = 7;
  const suffixLen = Math.min(a.length, b.length);
  if (suffixLen < minSuffix) return false;
  return a.endsWith(b) || b.endsWith(a);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function msToLocalTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  // Local time (no Z)
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const ms3 = pad3(d.getMilliseconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms3}`;
}

function parseJsonOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function compactText(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function isoToLocalTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const ms3 = pad3(d.getMilliseconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms3}`;
}

function isoToLocalTimeOnly(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const ms3 = pad3(d.getMilliseconds());
  return `${hh}:${mi}:${ss}.${ms3}`;
}

function condensedFunctionResultsLines(data) {
  const parsed = typeof data === 'string' ? parseJsonOrNull(data) : data;
  const rows = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = row.name ?? 'UNKNOWN';
    const inner = parseNestedResult(row.result);
    if (inner && typeof inner === 'object') {
      const status = inner.status ?? 'unknown';
      const reason = inner.reason ?? '';
      out.push(
        `FUNCTION_RESULT ${name}: ${status}${reason ? ` (${compactText(reason)})` : ''} ${compactText(
          JSON.stringify(inner),
        )}`,
      );
    } else if (row.result != null) {
      out.push(
        `FUNCTION_RESULT ${name}: ${compactText(
          typeof row.result === 'string' ? row.result : JSON.stringify(row.result),
        )}`,
      );
    } else {
      out.push(`FUNCTION_RESULT ${name}: ${compactText(JSON.stringify(row))}`);
    }
  }
  return out;
}

function condensedTranscriptLines(logs) {
  const lines = [];
  for (const entry of Array.isArray(logs) ? logs : []) {
    const type = entry?.type;
    const t =
      isoToLocalTimeOnly(entry?.createdAt) ??
      isoToLocalTimeOnly(entry?.updatedAt) ??
      '--:--:--.---';
    if (type === 'user') {
      lines.push(`${t} USER: ${compactText(entry.data)}`);
    } else if (type === 'agent') {
      lines.push(`${t} AGENT: ${compactText(entry.data)}`);
    } else if (type === 'hangup') {
      lines.push(`${t} HANGUP: ${compactText(entry.data)}`);
    } else if (type === 'function_results') {
      for (const l of condensedFunctionResultsLines(entry.data)) {
        lines.push(`${t} ${l}`);
      }
    } else if (type === 'function_calls') {
      const d = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
      lines.push(`${t} FUNCTION_CALLS: ${compactText(d)}`);
    }
  }
  return lines;
}

const ANSI_GREEN = '\x1b[32m';
const ANSI_RESET = '\x1b[0m';

const TRANSFER_OK_REASON = 'Transfer completed successfully';

function parseNestedResult(value) {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') return parseJsonOrNull(value);
  return null;
}

function functionResultsDataHasCompletedTransfer(data) {
  const parsed = typeof data === 'string' ? parseJsonOrNull(data) : data;
  const rows = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
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

function isFailedTransferResult(inner) {
  if (!inner || typeof inner !== 'object') return false;
  const st = String(inner.status ?? '').toUpperCase();

  // Primary: explicit FAILED TransferResult { status: "FAILED", reason: "..." }
  if (st === 'FAILED') {
    if (inner.reason === TRANSFER_OK_REASON) return false;
    return (
      reasonLooksLikeTransferFailure(inner.reason) ||
      reasonLooksLikeTransferFailure(inner.error) ||
      reasonLooksLikeTransferFailure(inner.message)
    );
  }

  // Some vendors/errors return { error: "twirp error ... sip status: 500 ..." } with no status.
  if (inner.error || inner.message) {
    const errText = inner.error ?? inner.message;
    return (
      reasonLooksLikeTransferFailure(errText) ||
      String(errText).toLowerCase().includes('sip status')
    );
  }

  return false;
}

function functionResultsDataHasFailedTransfer(data) {
  const parsed = typeof data === 'string' ? parseJsonOrNull(data) : data;
  const rows = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const inner = parseNestedResult(row.result) ?? parseNestedResult(row);
    if (isFailedTransferResult(inner)) return true;
  }
  return false;
}

function classifyFromLogs(logs) {
  const hasUserTurn = Array.isArray(logs) && logs.some((l) => l?.type === 'user');
  if (!hasUserTurn) return "Caller didn't speak (no user turn)";

  const functionResults = (Array.isArray(logs) ? logs : []).filter(
    (l) => l?.type === 'function_results',
  );

  const completed = functionResults.some((l) =>
    functionResultsDataHasCompletedTransfer(l.data),
  );
  if (completed) return 'transfer claimed to complete (outbound leg telephony issue?)';

  const failed = functionResults.some((l) =>
    functionResultsDataHasFailedTransfer(l.data),
  );
  if (failed) return 'transfer attempted but failed (outbound leg telephony issue?)';

  const attempted = completed || failed;
  if (!attempted) return 'no transfer attempt (investigate)';

  return 'unknown';
}

function pct(count, total) {
  if (!total) return 'n/a';
  return `${((100 * count) / total).toFixed(2)}%`;
}

async function fetchAbandonedRows(url) {
  const baseUrl = new URL(url);
  const collected = [];
  const maxPages = 500;

  let page = Number(baseUrl.searchParams.get('page') || '1');
  if (!Number.isFinite(page) || page < 1) page = 1;

  let total = null;
  let pageSize = null;

  for (let i = 0; i < maxPages; i++) {
    baseUrl.searchParams.set('page', String(page));
    const { data } = await axios.get(baseUrl.toString(), { timeout: 30000 });

    const block = data?.block;
    const rows = block?.rows;
    if (!Array.isArray(rows)) {
      throw new Error('Unexpected abandoned calls response: block.rows is not an array');
    }

    if (total == null && Number.isFinite(Number(block?.total))) {
      total = Number(block.total);
    }
    if (pageSize == null && Number.isFinite(Number(block?.page_size))) {
      pageSize = Number(block.page_size);
    }

    collected.push(...rows);

    // Stop when we've reached the advertised total.
    if (total != null && collected.length >= total) {
      break;
    }

    // If the server returns an empty page, we're done.
    if (rows.length === 0) {
      break;
    }

    // If page_size is known and this page wasn't full, we're at the end.
    if (pageSize != null && rows.length < pageSize) {
      break;
    }

    page += 1;
  }

  // If total exists, truncate to exact total to avoid accidental over-collection.
  if (total != null && collected.length > total) {
    return collected.slice(0, total);
  }

  return collected;
}

async function fetchCallsInWindow(api, { startDate, endDate, limit }) {
  const calls = [];
  let lastIndex = undefined;

  while (calls.length < limit) {
    const params = {
      startDate,
      endDate,
      lastIndex,
      limit: Math.min(200, limit - calls.length),
    };
    const { data } = await api.get('/calls', { params });
    const page = Array.isArray(data?.calls) ? data.calls : [];
    calls.push(...page);
    const next = data?.next;
    if (!next || page.length === 0) break;
    lastIndex = next;
  }
  return calls;
}

function cacheKeyForCalls({ server, startDate, endDate }) {
  const h = createHash('sha1');
  h.update(String(server));
  h.update('|');
  h.update(String(startDate));
  h.update('|');
  h.update(String(endDate));
  return h.digest('hex');
}

function callsCachePath(key) {
  // Requested /tmp; on mac this is typically /var/folders/... but os.tmpdir() is correct.
  const dir = path.join(os.tmpdir(), 'llm-agent-cache');
  return { dir, file: path.join(dir, `calls-${key}.json`) };
}

async function loadCallsCache({ server, startDate, endDate }) {
  const key = cacheKeyForCalls({ server, startDate, endDate });
  const { file } = callsCachePath(key);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.meta &&
      parsed.meta.server === server &&
      parsed.meta.startDate === startDate &&
      parsed.meta.endDate === endDate &&
      Array.isArray(parsed.calls)
    ) {
      return parsed;
    }
  } catch {
    // ignore missing/invalid cache
  }
  return null;
}

async function saveCallsCache({ server, startDate, endDate, calls, next }) {
  const key = cacheKeyForCalls({ server, startDate, endDate });
  const { dir, file } = callsCachePath(key);
  await fs.mkdir(dir, { recursive: true });
  const payload = {
    meta: { server, startDate, endDate, savedAt: new Date().toISOString() },
    next: next ?? null,
    calls,
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
}

async function fetchCallsPaged(api, { startDate, endDate, startLastIndex, maxPages }) {
  const out = [];
  let lastIndex = startLastIndex;
  let pages = 0;
  while (pages < maxPages) {
    pages += 1;
    const params = {
      startDate,
      endDate,
      lastIndex,
      // Server may clamp this; still request high.
      limit: 200,
    };
    const { data } = await api.get('/calls', { params });
    const page = Array.isArray(data?.calls) ? data.calls : [];
    out.push(...page);
    const next = data?.next;
    if (!next || page.length === 0) {
      return { calls: out, next: null };
    }
    lastIndex = next;
  }
  return { calls: out, next: lastIndex ?? null };
}

async function getCallsWithCache(api, { server, startDate, endDate, limitCalls }) {
  const cache = await loadCallsCache({ server, startDate, endDate });
  const seen = new Set();
  const calls = [];

  if (cache?.calls?.length) {
    for (const c of cache.calls) {
      if (c?.id && !seen.has(c.id)) {
        seen.add(c.id);
        calls.push(c);
      }
    }
  }

  // Continue pagination from where cache left off (if it was incomplete).
  const maxPages = 500;
  const continued = await fetchCallsPaged(api, {
    startDate,
    endDate,
    startLastIndex: cache?.next || undefined,
    maxPages,
  });
  for (const c of continued.calls) {
    if (c?.id && !seen.has(c.id)) {
      seen.add(c.id);
      calls.push(c);
    }
  }

  // Refresh: fetch the newest first page again and merge in any new calls.
  // This is cheap and helps if new calls appeared since the cache was first built.
  const refreshed = await fetchCallsPaged(api, {
    startDate,
    endDate,
    startLastIndex: undefined,
    maxPages: 1,
  });
  for (const c of refreshed.calls) {
    if (c?.id && !seen.has(c.id)) {
      seen.add(c.id);
      calls.push(c);
    }
  }

  // Persist combined list and pagination continuation marker.
  await saveCallsCache({
    server,
    startDate,
    endDate,
    calls,
    next: continued.next,
  });

  // Apply an optional cap, keeping MOST RECENT calls.
  // The /calls API pagination is oldest-first, so slicing the front would drop recent calls.
  if (limitCalls != null && Number.isFinite(Number(limitCalls))) {
    const n = Math.max(0, Number(limitCalls));
    const sorted = [...calls].sort((a, b) => {
      const ta = new Date(a?.startedAt || a?.createdAt || 0).getTime();
      const tb = new Date(b?.startedAt || b?.createdAt || 0).getTime();
      return tb - ta;
    });
    return sorted.slice(0, n);
  }

  return calls;
}

function pickBestCandidate(abandonedRow, calls, toleranceMs) {
  const targetMs = Number(abandonedRow?.started_at_ms);
  if (!Number.isFinite(targetMs)) return null;
  const cli = abandonedRow?.cli;
  // Observed consistent ~10s offset due to pre-announcement.
  const effectiveTargetMs = targetMs + 10000;

  let best = null;
  let bestDelta = Infinity;
  for (const call of calls) {
    if (!callerMatches(cli, call?.callerId)) continue;
    const startedAt = call?.startedAt;
    if (!startedAt) continue;
    const callMs = new Date(startedAt).getTime();
    if (!Number.isFinite(callMs)) continue;
    const delta = Math.min(
      Math.abs(callMs - targetMs),
      Math.abs(callMs - effectiveTargetMs),
    );
    if (delta <= toleranceMs && delta < bestDelta) {
      best = call;
      bestDelta = delta;
    }
  }
  return best ? { call: best, deltaMs: bestDelta } : null;
}

function correlationCandidates(abandonedRow, calls) {
  const targetMs = Number(abandonedRow?.started_at_ms);
  if (!Number.isFinite(targetMs)) return [];
  const cli = abandonedRow?.cli;
  const effectiveTargetMs = targetMs + 10000;

  const out = [];
  for (const call of calls) {
    if (!callerMatches(cli, call?.callerId)) continue;
    const startedAt = call?.startedAt;
    if (!startedAt) continue;
    const callMs = new Date(startedAt).getTime();
    if (!Number.isFinite(callMs)) continue;
    const deltaRaw = Math.abs(callMs - targetMs);
    const deltaOffset = Math.abs(callMs - effectiveTargetMs);
    const delta = Math.min(deltaRaw, deltaOffset);
    out.push({
      callId: call?.id,
      callerId: call?.callerId,
      calledId: call?.calledId,
      startedAt,
      deltaMs: delta,
      deltaRawMs: deltaRaw,
      deltaOffsetMs: deltaOffset,
    });
  }
  out.sort((a, b) => a.deltaMs - b.deltaMs);
  return out;
}

async function main() {
  if (options.help) {
    usage();
    process.exit(0);
  }

  if (!options.url) {
    usage();
    throw new Error('Missing --url.');
  }

  if (!options.key) {
    throw new Error('Missing API key. Please set API_KEY or pass --key.');
  }

  const abandonedRows = await fetchAbandonedRows(options.url);
  if (abandonedRows.length === 0) {
    console.log('No abandoned rows returned.');
    return;
  }

  const startedMs = abandonedRows
    .map((r) => Number(r?.started_at_ms))
    .filter((n) => Number.isFinite(n));
  const minMs = Math.min(...startedMs);
  const maxMs = Math.max(...startedMs);
  const padMs = Math.max(0, Number(options.padMinutes) || 0) * 60 * 1000;

  const startDate = new Date(minMs - padMs).toISOString();
  const endDate = new Date(maxMs + padMs).toISOString();

  const api = axios.create({
    baseURL: `${options.server.replace(/\/$/, '')}/api`,
    headers: { Authorization: `Bearer ${options.key}` },
    timeout: 30000,
  });

  const calls = await getCallsWithCache(api, {
    server: options.server.replace(/\/$/, ''),
    startDate,
    endDate,
    limitCalls: options.limitCalls,
  });

  // With command-line-args and `type: String`, `--verbose` with no value becomes null.
  const verboseModeRaw = options.verbose;
  const verboseMode =
    verboseModeRaw === undefined || verboseModeRaw === null || verboseModeRaw === 'false'
      ? (process.argv.includes('--verbose') || process.argv.includes('-v') ? 'all' : null)
      : verboseModeRaw === '' || verboseModeRaw === 'true'
        ? 'all'
        : String(verboseModeRaw).toLowerCase();

  const counts = {
    total: abandonedRows.length,
    noCorrelatedCall: 0,
    logsFetchFailed: 0,
    noUserTurn: 0,
    transferClaimedComplete: 0,
    transferFailed: 0,
    noTransferAttempt: 0,
    unknown: 0,
  };

  for (const row of abandonedRows) {
    const match = pickBestCandidate(row, calls, options.toleranceMs);
    const startedAtLocal = msToLocalTime(row.started_at_ms);
    if (!match) {
      counts.noCorrelatedCall += 1;
      console.log(
        `${row.wildix_call_id} cli=${row.cli} ${startedAtLocal ?? 'unknown'} -> unknown (no correlated call)`,
      );

      if (options['debug-correlation']) {
        const cands = correlationCandidates(row, calls);
        const limit = Math.max(0, Number(options['debug-correlation-limit']) || 0);
        console.error(
          `[debug-correlation] wildix_call_id=${row.wildix_call_id} cli=${row.cli} started_at=${startedAtLocal ?? 'unknown'} toleranceMs=${options.toleranceMs}`,
        );
        if (cands.length === 0) {
          console.error(`  no candidates matched callerId digits/suffix`);
        } else {
          console.error(`  candidates (best ${Math.min(limit, cands.length)} of ${cands.length}):`);
          for (const c of cands.slice(0, limit)) {
            console.error(
              `  - callId=${c.callId} callerId=${c.callerId} calledId=${c.calledId} startedAt=${c.startedAt} Δ=${c.deltaMs}ms (raw=${c.deltaRawMs}ms, +10s=${c.deltaOffsetMs}ms)`,
            );
          }
        }
      }

      continue;
    }

    let logs = [];
    try {
      const { data } = await api.get(`/calls/${match.call.id}/logs`);
      logs = Array.isArray(data) ? data : [];
    } catch (e) {
      counts.logsFetchFailed += 1;
      console.log(
        `${row.wildix_call_id} cli=${row.cli} ${startedAtLocal ?? 'unknown'} -> unknown (failed to fetch logs for callId ${match.call.id})`,
      );
      continue;
    }

    const description = classifyFromLogs(logs);
    if (description === "Caller didn't speak (no user turn)") {
      counts.noUserTurn += 1;
    } else if (description.startsWith('transfer claimed to complete')) {
      counts.transferClaimedComplete += 1;
    } else if (description.startsWith('transfer attempted but failed')) {
      counts.transferFailed += 1;
    } else if (description === 'no transfer attempt (investigate)') {
      counts.noTransferAttempt += 1;
    } else {
      counts.unknown += 1;
    }
    const isNoTransfer = description === 'no transfer attempt (investigate)';
    const isTransferAttempted =
      description.startsWith('transfer claimed to complete') ||
      description.startsWith('transfer attempted but failed');

    console.log(
      `${row.wildix_call_id} cli=${row.cli} ${startedAtLocal ?? 'unknown'} -> callId=${match.call.id} Δ=${match.deltaMs}ms: ${description}`,
    );

    const shouldPrintTranscript =
      verboseMode === 'no-transfer'
        ? isNoTransfer
        : verboseMode === 'transfer-fail'
          ? isTransferAttempted
          : verboseMode === 'all'
            ? true
            : false;

    if (shouldPrintTranscript) {
      const transcript = condensedTranscriptLines(logs);
      for (const line of transcript) {
        console.log(`${ANSI_GREEN}  ${line}${ANSI_RESET}`);
      }
    }
  }

  const total = counts.total;
  console.error(
    [
      `Summary: total abandoned rows: ${total}`,
      `no correlated call: ${counts.noCorrelatedCall} (${pct(counts.noCorrelatedCall, total)})`,
      `logs fetch failed: ${counts.logsFetchFailed} (${pct(counts.logsFetchFailed, total)})`,
      `caller didn't speak: ${counts.noUserTurn} (${pct(counts.noUserTurn, total)})`,
      `transfer claimed to complete: ${counts.transferClaimedComplete} (${pct(counts.transferClaimedComplete, total)})`,
      `transfer attempted but failed: ${counts.transferFailed} (${pct(counts.transferFailed, total)})`,
      `no transfer attempt: ${counts.noTransferAttempt} (${pct(counts.noTransferAttempt, total)})`,
      `unknown: ${counts.unknown} (${pct(counts.unknown, total)})`,
    ].join('; '),
  );
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});

