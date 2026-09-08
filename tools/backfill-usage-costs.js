#!/usr/bin/env node
/**
 * Value the usage backlog — the rows metered before rate assignment worked.
 *
 * Two independent things leave historical usage permanently unpriced, and
 * fixing either alone changes nothing:
 *
 *  1. **The organisation's rate timeline starts too late.** A card is assigned
 *     with `startDate = the moment of assignment`, so every row metered before
 *     that resolves NO rate name at all and settles `cost_status='no_rate'`.
 *     Re-running the sweep will keep producing `no_rate` for ever.
 *  2. **No card VERSION covers the billing instant.** Even with the name
 *     resolved, `resolveRateCard` needs a card whose `startDate <= billedAt`.
 *     The plan cards start 2026-08-20; the legacy `default` card that does cover
 *     mid-2026 has no LLM, TTS or STT lines, so those rows merely move from
 *     `no_rate` to `no_line`.
 *
 * This tool does (1) — backdating each organisation's rate history to the
 * earliest moment it could possibly owe anything. (2) is the backdated card
 * versions in polite-ai `data/build-rate-cards.mjs`, imported through the Rates
 * screen; import those FIRST or this achieves nothing.
 *
 * `--apply` is required to write. Without it the tool reports exactly what it
 * would do and touches nothing, because the sweep that follows settles real
 * money against real balances.
 *
 *   node tools/backfill-usage-costs.js -p .env.beta            # report only
 *   node tools/backfill-usage-costs.js -p .env.beta --apply
 *
 * Then run the sweep itself (POST /api/agent-db/sweep, `dryRun` first) to value
 * and settle the rows this makes rateable.
 */
import dotenv from 'dotenv';
import dir from 'path';
import commandLineArgs from 'command-line-args';

const options = commandLineArgs([
  { name: 'path', alias: 'p', type: String },
  { name: 'apply', type: Boolean },
  { name: 'rate', alias: 'r', type: String, description: 'Rate name for orgs with none at all' },
]);
dotenv.config(options.path ? { path: dir.resolve(process.cwd(), options.path) } : undefined);

const { Organisation, UsageRecord, RateCard, Op, databaseStarted } = await import('../lib/database.js');
const { resolveRateCard } = await import('../lib/rates.js');

await databaseStarted;

const orgs = await Organisation.findAll();
const plans = [];

for (const org of orgs) {
  const history = Array.isArray(org.rateHistory) ? [...org.rateHistory] : [];
  // The earliest instant this organisation could owe anything. `billedAt` is
  // null until a row is costed, so fall back to createdAt exactly as the
  // costing path's own anchor resolution does.
  // The floor is the earliest instant this organisation could owe anything, and
  // two things make that earlier than it looks.
  //
  // Rows the sweep is ABOUT to attribute count towards it. A row written with a
  // user but no organisation (lib/set-builder-agent.js takes
  // `user.organisationId ?? null`) is recovered from its user by
  // `attributeOrphanRow`, but that happens during the sweep, after this floor
  // is fixed.
  //
  // And a row is billed at its BILLING instant, not at the moment it was
  // written: `resolveBilledAt` prefers billed_at, then the call's start, then
  // the `metadata.startedAt` anchor a text session carries. That anchor is the
  // session start, so it precedes created_at — by nine seconds on the rows this
  // was measured against, which was enough to leave them just before a floor
  // taken from created_at, resolving no rate for ever.
  //
  // Erring early is free: no usage exists before the earliest row, so a floor
  // set earlier than necessary rates nothing extra.
  const [[earliestRow]] = await UsageRecord.sequelize.query(
    `SELECT MIN(LEAST(
              COALESCE(u.billed_at, u.created_at),
              COALESCE(c.started_at, u.created_at),
              CASE WHEN u.metadata->>'startedAt' ~ '^[0-9]{4}-'
                   THEN (u.metadata->>'startedAt')::timestamptz
                   ELSE u.created_at END,
              u.created_at)) AS earliest
       FROM usage_records u
       LEFT JOIN calls c ON c.id = u.call_id
      WHERE u.organisation_id = :orgId
         OR (u.organisation_id IS NULL
             AND u.user_id IN (SELECT id FROM users WHERE organisation_id = :orgId))`,
    { replacements: { orgId: org.id } },
  );
  const earliest = earliestRow?.earliest;
  if (!earliest) continue;

  const floor = new Date(Math.min(new Date(earliest).getTime(), new Date(org.createdAt).getTime()));

  if (!history.length) {
    // No rate at all. Assigning one here would invent a commercial relationship
    // this tool has no business inventing, so it is opt-in and named explicitly.
    if (!options.rate) {
      plans.push({ org, action: 'skip', why: 'no rate history; pass --rate <name> to assign one' });
      continue;
    }
    plans.push({
      org, action: 'assign', from: null, to: floor.toISOString(), name: options.rate,
      next: [{ name: options.rate, startDate: floor.toISOString() }],
    });
    continue;
  }

  const first = history[0];
  const current = new Date(first.startDate);
  if (current <= floor) {
    plans.push({ org, action: 'ok', why: `already covers from ${first.startDate}` });
    continue;
  }

  // Only the EARLIEST entry moves. A later entry is a real plan change with a
  // real date, and dragging it back would re-price usage that was correctly
  // valued under the previous card.
  const next = [{ ...first, startDate: floor.toISOString() }, ...history.slice(1)];
  const card = await resolveRateCard(first.name, floor, { RateCard });
  plans.push({
    org,
    action: 'backdate',
    from: first.startDate,
    to: floor.toISOString(),
    name: first.name,
    next,
    // Reported, not enforced: backdating the NAME is still the right move even
    // where no card version covers the new floor yet — importing one later then
    // completes the fix without re-running this.
    warning: card ? null : `no "${first.name}" card version covers ${floor.toISOString()} — import the backdated card bundle or these rows stay no_rate`,
  });
}

const width = Math.max(...plans.map((p) => (p.org.name || p.org.id).length), 12);
for (const p of plans) {
  const name = (p.org.name || p.org.id).padEnd(width);
  if (p.action === 'ok' || p.action === 'skip') {
    console.log(`  ${p.action === 'ok' ? '·' : '!'} ${name}  ${p.why}`);
    continue;
  }
  console.log(`  ${options.apply ? '→' : '?'} ${name}  ${p.name}: ${p.from ?? '(none)'} → ${p.to}`);
  if (p.warning) console.log(`    ⚠ ${p.warning}`);
}

const changing = plans.filter((p) => p.action === 'backdate' || p.action === 'assign');
if (!options.apply) {
  console.log(`\n${changing.length} organisation(s) would change. Re-run with --apply to write.`);
  console.log('Import the backdated rate-card versions FIRST, or the rows stay uncosted.');
} else {
  for (const p of changing) await p.org.update({ rateHistory: p.next });
  console.log(`\n${changing.length} organisation(s) updated.`);
  console.log('Now run the sweep to value them: POST /api/agent-db/sweep {"dryRun":true} first.');
}

// A count of what is still unvalued, so the effect is measurable either way.
const stuck = await UsageRecord.count({
  where: { finalised: true, [Op.or]: [{ costMicros: null }, { costStatus: { [Op.in]: ['no_rate', 'errored'] } }] },
});
console.log(`${stuck} finalised row(s) currently carry no cost.`);
process.exit(0);
