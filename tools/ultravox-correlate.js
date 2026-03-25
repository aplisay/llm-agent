#!/usr/bin/env node
import dotenv from 'dotenv';
import dir from 'path';
import axios from 'axios';
import commandLineArgs from 'command-line-args';

const optionDefinitions = [
  { name: 'path', alias: 'p', type: String },
  { name: 'windowMinutes', alias: 'w', type: Number, defaultValue: 5 },
  { name: 'candidateLimit', alias: 'c', type: Number, defaultValue: 50 },
  { name: 'maxStartOffsetMs', alias: 's', type: Number, defaultValue: 3000 },
  { name: 'debug', alias: 'd', type: Boolean, defaultValue: false },
  { name: 'help', alias: 'h', type: Boolean, defaultValue: false },
];

const options = commandLineArgs(optionDefinitions);
if (options.help) {
  console.log(`Usage: ${process.argv[1]} [options] < input.txt`);
  console.log('Options:');
  console.log('  -p, --path <path>           Path to env file (default: .env)');
  console.log('  -w, --windowMinutes <num>   Search window before call start (default: 5)');
  console.log('  -c, --candidateLimit <num>  Max Ultravox candidates to score (default: 50)');
  console.log('  -s, --maxStartOffsetMs <n>  Hard reject start offset above this (default: 3000)');
  console.log('  -d, --debug                 Emit Ultravox correlation debug to stderr');
  process.exit(0);
}

const configArgs = options.path ? { path: dir.resolve(process.cwd(), options.path) } : {};
dotenv.config(configArgs);

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ULTRAVOX_BASE_URL = 'https://api.ultravox.ai/api/';

let started;

function debugLog(message, payload) {
  if (!options.debug) return;
  if (payload === undefined) {
    console.error(`[ultravox-correlate] ${message}`);
    return;
  }
  console.error(`[ultravox-correlate] ${message} ${JSON.stringify(payload)}`);
}

function formatUrlWithParams(baseURL, path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.append(k, String(v));
  }
  const query = qs.toString();
  return `${baseURL}${path}${query ? `?${query}` : ''}`;
}

async function fetchAllUltravoxCalls(api, initialPath, initialParams, label) {
  const allResults = [];
  const maxPages = 200;
  let page = 0;
  let nextPath = initialPath;
  let nextParams = initialParams;

  while (nextPath && page < maxPages) {
    page++;
    const logUrl = (nextParams && Object.keys(nextParams).length)
      ? formatUrlWithParams(ULTRAVOX_BASE_URL, nextPath, nextParams)
      : `${ULTRAVOX_BASE_URL}${nextPath}`;
    debugLog(`ultravox GET (${label} page ${page})`, { url: logUrl, params: nextParams || null });

    const { data } = await api.get(nextPath, nextParams ? { params: nextParams } : undefined);
    const pageResults = Array.isArray(data?.results) ? data.results : [];
    allResults.push(...pageResults);

    const nextRaw = typeof data?.next === 'string' ? data.next : null;
    debugLog(`ultravox page response (${label} page ${page})`, {
      pageResults: pageResults.length,
      accumulatedResults: allResults.length,
      hasNext: !!nextRaw,
    });

    if (!nextRaw) break;

    // Ultravox next can be relative ("calls?...") or absolute URL.
    const parsed = new URL(nextRaw, ULTRAVOX_BASE_URL);
    nextPath = parsed.pathname.replace(/^\/api\//, '');
    nextParams = null; // query is already encoded in nextPath
    if (parsed.search) {
      nextPath += parsed.search;
    }
  }

  if (page >= maxPages && nextPath) {
    debugLog(`stopped pagination early at safety cap (${maxPages} pages)`, { label });
  }
  return allResults;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

function uniq(arr) {
  return [...new Set(arr)];
}

function asPlain(obj) {
  if (!obj) return null;
  if (typeof obj.toJSON === 'function') return obj.toJSON();
  return obj;
}

function simplifyLocalTranscript(logs) {
  const transcriptTypes = new Set(['agent', 'user', 'function_results', 'rest_callout', 'error']);
  const entries = [];
  for (const log of logs || []) {
    if (!transcriptTypes.has(log.type)) continue;
    let text = '';
    if (typeof log.data === 'string') {
      text = log.data;
    } else if (log.data != null) {
      try {
        text = JSON.stringify(log.data);
      } catch (err) {
        text = String(log.data);
      }
    }
    if (!text) continue;
    entries.push({
      type: log.type,
      createdAt: log.createdAt,
      text,
    });
  }
  return entries;
}

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text) {
  const s = new Set();
  for (const tok of normalizeText(text).split(' ')) {
    if (tok && tok.length > 2) s.add(tok);
  }
  return s;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let intersection = 0;
  for (const v of a) {
    if (b.has(v)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function getDurationMs(call) {
  if (typeof call?.duration === 'number' && Number.isFinite(call.duration)) return call.duration;
  if (call?.startedAt && call?.endedAt) {
    const d = new Date(call.endedAt).valueOf() - new Date(call.startedAt).valueOf();
    return Number.isFinite(d) && d >= 0 ? d : null;
  }
  return null;
}

async function fetchUltravoxCalls(api, localCall, localTranscriptText) {
  const startedAt = localCall?.startedAt ? new Date(localCall.startedAt) : null;
  if (!startedAt || Number.isNaN(startedAt.valueOf())) {
    return { candidates: [], best: null, reason: 'local call has no valid startedAt' };
  }

  const localDurationMs = getDurationMs(localCall) || 0;
  const preStartMs = 120 * 1000;
  const lowerBound = new Date(startedAt.valueOf() - preStartMs);
  const upperBound = new Date(lowerBound.valueOf() + localDurationMs + 120 * 1000);
  const params = {
    limit: Math.max(1, options.candidateLimit),
    fromDate: lowerBound.toISOString(),
    toDate: upperBound.toISOString(),
  };
  debugLog('querying Ultravox calls with primary filter', {
    localCallId: localCall?.id,
    localStartedAt: startedAt.toISOString(),
    localDurationMs,
    preStartMs,
    params,
    maxStartOffsetMs: options.maxStartOffsetMs,
  });

  let results = [];
  let usedFallback = false;
  try {
    results = await fetchAllUltravoxCalls(api, 'calls', params, 'primary');
    debugLog('primary Ultravox calls query returned', { count: results.length });
  } catch (err) {
    // Fallback if server rejects unknown filter naming.
    usedFallback = true;
    debugLog('primary Ultravox calls query failed; using fallback unfiltered call list', {
      error: err?.message,
    });
    const fallbackParams = {
      limit: Math.max(1, options.candidateLimit),
    };
    results = await fetchAllUltravoxCalls(api, 'calls', fallbackParams, 'fallback');
    debugLog('fallback Ultravox calls query returned', { count: results.length });
  }

  const createdValues = results
    .map((r) => r?.created)
    .filter(Boolean)
    .map((d) => new Date(d).valueOf())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (createdValues.length) {
    const sample = results.slice(0, 5).map((r) => ({
      callId: r?.callId,
      created: r?.created,
      ended: r?.ended || null,
    }));
    debugLog('ultravox returned call time range', {
      minCreated: new Date(createdValues[0]).toISOString(),
      maxCreated: new Date(createdValues[createdValues.length - 1]).toISOString(),
      sample,
    });
  } else {
    debugLog('ultravox returned no parseable created timestamps');
  }

  const localStartMs = startedAt.valueOf();
  const localTokens = tokenSet(localTranscriptText || '');

  const scored = [];
  let rejectedByStartOffset = 0;
  let rejectedByInvalidStart = 0;
  for (const candidate of results) {
    const candidateStartMs = candidate?.created ? new Date(candidate.created).valueOf() : null;
    if (!Number.isFinite(candidateStartMs)) {
      rejectedByInvalidStart++;
      continue;
    }

    const startDeltaMs = Math.abs(candidateStartMs - localStartMs);
    if (startDeltaMs > options.maxStartOffsetMs) {
      rejectedByStartOffset++;
      debugLog('rejecting candidate by hard start-offset threshold', {
        localCallId: localCall?.id,
        candidateCallId: candidate?.callId,
        startDeltaMs,
        thresholdMs: options.maxStartOffsetMs,
      });
      continue;
    }

    const candidateDurationMs = Number.isFinite(candidate?.duration)
      ? Number(candidate.duration) * 1000
      : (candidate?.ended ? new Date(candidate.ended).valueOf() - candidateStartMs : null);
    const durationDeltaMs = (
      localDurationMs != null && Number.isFinite(candidateDurationMs)
    ) ? Math.abs(candidateDurationMs - localDurationMs) : null;

    let msgText = '';
    let transcriptScore = 0;
    let messages = [];
    try {
      const { data: msgData } = await api.get(`calls/${candidate.callId}/messages`, { params: { limit: 200 } });
      messages = Array.isArray(msgData?.results) ? msgData.results : [];
      msgText = messages.map((m) => m?.text || '').filter(Boolean).join(' ');
      const candidateTokens = tokenSet(msgText);
      transcriptScore = jaccard(localTokens, candidateTokens);
    } catch (err) {
      // Keep candidate, just with no transcript score.
    }

    const startScore = Math.max(0, 1 - (startDeltaMs / (10 * 60 * 1000)));
    const durationScore = durationDeltaMs == null ? 0.3 : Math.max(0, 1 - (durationDeltaMs / (5 * 60 * 1000)));
    const totalScore = (0.55 * startScore) + (0.25 * durationScore) + (0.20 * transcriptScore);

    scored.push({
      candidate,
      messages,
      score: totalScore,
      reasons: {
        startDeltaMs,
        durationDeltaMs,
        transcriptScore,
      },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  debugLog('ultravox candidate scoring complete', {
    localCallId: localCall?.id,
    usedFallback,
    rawCandidateCount: results.length,
    scoredCount: scored.length,
    rejectedByStartOffset,
    rejectedByInvalidStart,
    best: scored[0]
      ? {
        callId: scored[0].candidate?.callId,
        score: scored[0].score,
        reasons: scored[0].reasons,
      }
      : null,
  });

  const topCandidates = scored.slice(0, 5).map((s) => ({
    callId: s.candidate?.callId,
    score: s.score,
    startDeltaMs: s.reasons?.startDeltaMs,
    durationDeltaMs: s.reasons?.durationDeltaMs,
    transcriptScore: s.reasons?.transcriptScore,
  }));
  if (topCandidates.length) {
    debugLog('top scored candidates', topCandidates);
  }

  if (!scored.length) {
    return {
      candidates: [],
      best: null,
      reason: `no candidates passed hard start-offset threshold (${options.maxStartOffsetMs}ms)`,
    };
  }
  return {
    candidates: scored,
    best: scored[0] || null,
    reason: null,
  };
}

function renderRecord({ callId, call, transactionLogs, localTranscript, correlation }) {
  const callJson = asPlain(call);
  const txJson = (transactionLogs || []).map(asPlain);

  const output = {
    callId,
    call: callJson,
    transactionLog: txJson,
    localTranscript: {
      entries: localTranscript,
      combinedText: localTranscript.map((e) => e.text).join('\n'),
    },
  };

  if (correlation?.best) {
    output.ultravoxCorrelation = {
      score: correlation.best.score,
      matchReason: correlation.best.reasons,
      call: correlation.best.candidate,
      transcript: (correlation.best.messages || []).map((m) => ({
        role: m.role,
        text: m.text,
        time: m.timestamp || m.created || null,
        toolName: m.toolName || null,
      })),
    };
  } else {
    output.ultravoxCorrelation = {
      score: 0,
      reason: correlation?.reason || 'correlation unavailable',
      call: null,
      transcript: [],
    };
  }

  return JSON.stringify(output, null, 2);
}

async function main() {
  const input = await readStdin();
  const uuids = uniq((input.match(UUID_RE) || []).map((u) => u.toLowerCase()));
  if (!uuids.length) {
    throw new Error('No UUIDs found on stdin');
  }

  const {
    Call,
    TransactionLog,
    stopDatabase,
    databaseStarted,
  } = await import('../lib/database.js');
  await databaseStarted;
  started = stopDatabase;

  const apiKey = process.env.ULTRAVOX_API_KEY;
  const api = apiKey ? axios.create({
    baseURL: ULTRAVOX_BASE_URL,
    headers: { 'X-API-Key': apiKey },
  }) : null;

  const outputRecords = [];
  for (const callId of uuids) {
    try {
      const call = await Call.findByPk(callId);
      const transactionLogs = await TransactionLog.findAll({
        where: { callId },
        order: [['createdAt', 'ASC']],
      });
      const localTranscript = simplifyLocalTranscript(transactionLogs.map(asPlain));
      const localTranscriptText = localTranscript.map((e) => e.text).join(' ');

      let correlation = { candidates: [], best: null, reason: 'ULTRAVOX_API_KEY is not set' };
      if (call && api) {
        try {
          correlation = await fetchUltravoxCalls(api, asPlain(call), localTranscriptText);
        } catch (err) {
          correlation = { candidates: [], best: null, reason: `Ultravox lookup failed: ${err.message}` };
        }
      } else if (!call) {
        correlation = { candidates: [], best: null, reason: 'call not found in local database' };
      }

      outputRecords.push(JSON.parse(
        renderRecord({ callId, call, transactionLogs, localTranscript, correlation })
      ));
    } catch (err) {
      debugLog('failed processing callId; continuing', { callId, error: err?.message });
      const errorOutput = {
        callId,
        error: err?.message || String(err),
        call: null,
        transactionLog: [],
        localTranscript: { entries: [], combinedText: '' },
        ultravoxCorrelation: {
          score: 0,
          reason: 'processing failed for this callId',
          call: null,
          transcript: [],
        },
      };
      outputRecords.push(errorOutput);
      continue;
    }
  }
  process.stdout.write(`${JSON.stringify(outputRecords, null, 2)}\n`);
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
