#!/usr/bin/env node
/**
 * Builder eval harness (Phase 3 of the builder cost/quality programme — see
 * polite-ai docs/builder-efficiency-review.md).
 *
 * Runs scripted build/edit/troubleshoot scenarios through the REAL chat loop
 * (lib/text-chat.js — LLM driver, tool dispatch, MCP connector, usage
 * metering) in-process against a disposable org, for each candidate model,
 * and reports: hard-check pass/fail, judge scores, tokens, estimated cost and
 * latency per scenario.
 *
 *   node tools/builder-eval/run.mjs [--models a,b] [--scenarios x,y] [--json out.json]
 *
 * Requirements: POSTGRES_* env pointing at a DISPOSABLE database (the tests
 * container works: tests/docker-compose.test.yml), ANTHROPIC_API_KEY (and any
 * other provider keys for their models). Spends real provider tokens.
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const { values: args } = parseArgs({
  options: {
    models: { type: 'string' },
    scenarios: { type: 'string' },
    json: { type: 'string' },
  },
});

// Import AFTER dotenv so database.js sees the env (same rule as index.mjs).
const { Organisation, User, databaseStarted, UsageRecord, stopDatabase } = await import('../../lib/database.js');
const { createAgentSetForAgent } = await import('../../lib/agent-set-service.js');
const { setBuilderAgent } = await import('../../lib/set-builder-agent.js');
const { scenarios } = await import('./scenarios.mjs');
const { runScenario } = await import('./driver.mjs');
const { judge } = await import('./judge.mjs');

const DEFAULT_MODELS = ['text:anthropic/claude-sonnet-5'];

// $/MTok — used for the per-run cost estimate in the report. Update as prices
// move; unknown models report tokens only. Verified July 2026 list prices
// (sonnet-5 has intro $2/$10 to 2026-08-31 — list price used for fairness).
// NOTE: the OpenAI Responses usage API doesn't split cache WRITES out of
// input_tokens (writes bill at 1.25x input on gpt-5.6+), so OpenAI costs are
// slightly underestimated on cache-miss-heavy runs.
const PRICES = {
  'anthropic/claude-sonnet-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'anthropic/claude-sonnet-4-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'anthropic/claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'anthropic/claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'openai/gpt-5.6-sol': { in: 5, out: 30, cacheRead: 0.5, cacheWrite: 0 },
  'openai/gpt-5.6-terra': { in: 2.5, out: 15, cacheRead: 0.25, cacheWrite: 0 },
  'openai/gpt-5.6-luna': { in: 1, out: 6, cacheRead: 0.1, cacheWrite: 0 },
  'openai/gpt-5.5': { in: 5, out: 30, cacheRead: 0.5, cacheWrite: 0 },
  'gemini/gemini-3.5-flash': { in: 1.5, out: 9, cacheRead: 0.15, cacheWrite: 0 },
  'kimi/kimi-k2.6': { in: 0.95, out: 4, cacheRead: 0.16, cacheWrite: 0 },
  // OpenRouter passes Moonshot pricing through (its fee is on credit top-ups).
  'openrouter/moonshotai/kimi-k2.6': { in: 0.95, out: 4, cacheRead: 0.16, cacheWrite: 0 },
};

const quietLogger = {
  fatal: () => {}, error: (...a) => console.error('[session]', a[0]?.message ?? a[1] ?? a[0]),
  warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
  child: () => quietLogger,
};

function costOf(model, usage) {
  const bare = String(model).replace(/^text:/, '');
  const p = PRICES[bare];
  if (!p || !usage) return null;
  return (
    (usage.inputTokens * p.in +
      usage.outputTokens * p.out +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}

async function usageFor(sessionId) {
  const rows = await UsageRecord.findAll({ where: { sessionId, technology: 'llm' }, raw: true });
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const KEYS = {
    input_tokens: 'inputTokens', output_tokens: 'outputTokens',
    cache_read_tokens: 'cacheReadTokens', cache_write_tokens: 'cacheWriteTokens',
  };
  for (const r of rows) if (KEYS[r.unit]) usage[KEYS[r.unit]] += Number(r.quantity) || 0;
  return usage;
}

async function main() {
  await databaseStarted;

  const modelIds = (args.models?.split(',') ?? DEFAULT_MODELS).map((m) => m.trim()).filter(Boolean);
  const wanted = args.scenarios?.split(',').map((s) => s.trim());
  const picked = wanted ? scenarios.filter((s) => wanted.includes(s.id)) : scenarios;
  if (!picked.length) throw new Error(`no scenarios matched: ${args.scenarios}`);

  // Disposable tenant per run — everything the builder creates lands here.
  const orgId = randomUUID();
  const userId = randomUUID();
  await Organisation.create({ id: orgId, name: `builder-eval ${new Date().toISOString()}` });
  await User.create({ id: userId, organisationId: orgId, name: 'builder-eval', email: `eval-${orgId}@example.invalid` });

  const results = [];
  for (const modelName of modelIds) {
    for (const scenario of picked) {
      process.stderr.write(`\n▶ ${modelName} × ${scenario.id} … `);
      const agent = { ...setBuilderAgent({ id: userId, organisationId: orgId }), modelName };
      const entry = { model: modelName, scenario: scenario.id, brief: scenario.brief };
      try {
        // A seeded set must be a SAVED set (that's the only shape production
        // ever seeds — polite-ai forwards a stored draft, ids and all). Create
        // it for real so the builder has an id to patch, then hand the
        // RENDERED doc to the session exactly as the chat API would.
        let runScenarioDef = scenario;
        if (scenario.seed?.set && !scenario.seed.set.id) {
          const rendered = await createAgentSetForAgent(scenario.seed.set, {
            userId,
            organisationId: orgId,
          });
          runScenarioDef = { ...scenario, seed: { ...scenario.seed, set: rendered } };
        }
        const result = await runScenario({ scenario: runScenarioDef, agent, logger: quietLogger });
        result.check = scenario.check({
          set: result.latestSet,
          frames: result.frames,
          transcript: result.transcript,
        });
        entry.hardCheck = result.check;
        entry.errors = result.errors;
        entry.turns = result.turnLatencies.length;
        entry.turnLatenciesMs = result.turnLatencies;
        entry.wallMs = result.wallMs;
        entry.usage = await usageFor(result.sessionId);
        entry.estCostUsd = costOf(modelName, entry.usage);
        entry.finalSet = result.latestSet; // keep the artefact for debugging
        entry.judge = await judge({ scenario, result });
        process.stderr.write(entry.hardCheck.ok ? 'hard-check PASS' : 'hard-check FAIL');
      } catch (e) {
        entry.failed = e.message;
        process.stderr.write(`RUN FAILED: ${e.message}`);
      }
      results.push(entry);
    }
  }

  // ---- report ---------------------------------------------------------------
  const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
  console.log('\n\n| model | scenario | hard | judge | out tok | in+cache tok | est $ | wall s |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.failed) {
      console.log(`| ${r.model} | ${r.scenario} | RUN FAILED | — | — | — | — | — |`);
      continue;
    }
    const u = r.usage;
    console.log(
      `| ${r.model} | ${r.scenario} | ${r.hardCheck.ok ? '✅' : '❌'} | ${r.judge.overall ?? '?'} / 10 | ` +
        `${fmtTok(u.outputTokens)} | ${fmtTok(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)} | ` +
        `${r.estCostUsd != null ? r.estCostUsd.toFixed(3) : '—'} | ${(r.wallMs / 1000).toFixed(0)} |`,
    );
  }
  for (const r of results) {
    if (r.failed) continue;
    console.log(`\n### ${r.model} × ${r.scenario}`);
    for (const n of r.hardCheck.notes) console.log(`- ${n}`);
    if (r.judge?.summary) console.log(`- judge: ${r.judge.summary}`);
    if (r.errors?.length) console.log(`- session errors: ${r.errors.join(' | ')}`);
  }

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ ranAt: new Date().toISOString(), orgId, results }, null, 2));
    console.log(`\nJSON written to ${args.json}`);
  }

  await stopDatabase?.();
  // The MCP connector / grace timers are unref'd; exit cleanly regardless.
  process.exit(results.some((r) => r.failed || (r.hardCheck && !r.hardCheck.ok)) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
