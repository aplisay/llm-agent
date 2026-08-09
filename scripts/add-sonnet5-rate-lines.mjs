/**
 * Idempotently add `anthropic/claude-sonnet-5` model token lines to the platform
 * default rate card (D5d of the polite-ai agent-builder design record). Without
 * these lines Sonnet-5 usage rows resolve `costStatus:'no_line'` and bill nothing.
 *
 *   node scripts/add-sonnet5-rate-lines.mjs        # from the repo root
 *
 * What it does:
 *   1. Resolves the target rate NAME: $RATE_NAME, else the `defaultRateName`
 *      Metadata singleton, else 'default'.
 *   2. Finds the card version covering now() and adds any MISSING model lines
 *      (input/output plus cache read/write token lines — prompt caching is now
 *      enabled on the Anthropic path). Lines already present are left untouched,
 *      so re-running is a no-op.
 *   3. Honours the card-immutability rule: if the covering version is already
 *      referenced by costed usage, it is SUPERSEDED (end-dated at now, new
 *      version inserted with the extra lines) instead of edited in place —
 *      mirroring the beforeUpdate guard in lib/database.js.
 *
 * Pricing (micro-pence per token; override via env):
 *   Sonnet 5 lists at $3/$15 per MTok upstream — the same list price as
 *   claude-sonnet-4-6. Neither the dev nor staging DB carries anthropic model
 *   lines to copy margins from, so the defaults are the same digits in GBP:
 *   input 3, output 15 micro-pence/token (~25-30% gross margin at typical FX),
 *   cache write = 1.25x input, cache read = 0.1x input (Anthropic's multipliers).
 *   SONNET5_INPUT_PRICE_MICROS / SONNET5_OUTPUT_PRICE_MICROS override the base
 *   prices; cache prices derive from input unless SONNET5_CACHE_WRITE_PRICE_MICROS /
 *   SONNET5_CACHE_READ_PRICE_MICROS are set. MODELS (comma-separated bare model
 *   ids, default 'claude-sonnet-5') selects which anthropic models to line up.
 *
 * PROD ROLLOUT: run once against the production DB —
 *   node scripts/add-sonnet5-rate-lines.mjs -p /path/to/prod.env
 * If production already carries anthropic sonnet-4-6 lines, FIRST read their
 * prices (SELECT detail FROM rate_cards ...) and pass matching
 * SONNET5_*_PRICE_MICROS so Sonnet-5 margins match Sonnet-4-6, per the design
 * record. Then sweep bespoke per-org cards for the same gap (any card named in
 * an organisation rateHistory that prices anthropic models needs the new lines
 * too). Costing of rows recorded before the lines exist is picked up by the
 * uncosted-row sweep once the lines are in place.
 *
 * Self-contained: loads ./.env and talks to Postgres directly (no app boot).
 */
import pg from 'pg';
import { loadEnv } from './env.mjs';

loadEnv();

const MODELS = (process.env.MODELS || 'claude-sonnet-5').split(',').map((m) => m.trim()).filter(Boolean);
const INPUT_PRICE = Number(process.env.SONNET5_INPUT_PRICE_MICROS || 3);
const OUTPUT_PRICE = Number(process.env.SONNET5_OUTPUT_PRICE_MICROS || 15);
// Derived cache prices are rounded to 6 dp to keep the stored JSON clean of
//  binary-float artifacts (0.30000000000000004 etc).
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const CACHE_WRITE_PRICE = Number(process.env.SONNET5_CACHE_WRITE_PRICE_MICROS || round6(INPUT_PRICE * 1.25));
const CACHE_READ_PRICE = Number(process.env.SONNET5_CACHE_READ_PRICE_MICROS || round6(INPUT_PRICE * 0.1));

const client = new pg.Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  ssl: process.env.POSTGRES_CA
    ? {
      ca: process.env.POSTGRES_CA,
      key: process.env.POSTGRES_KEY,
      cert: process.env.POSTGRES_CERT,
      servername: process.env.POSTGRES_RO_SERVER_NAME,
      rejectUnauthorized: false,
    }
    : false,
});

/** The four token lines a model needs on the card (matches lib/rates.js line shape). */
function modelLines(detail) {
  const match = (unit) => ({ technology: 'llm', provider: 'anthropic', detail, unit });
  return [
    { dim: 'model', match: match('input_tokens'), unit: 'token', priceMicros: INPUT_PRICE },
    { dim: 'model', match: match('output_tokens'), unit: 'token', priceMicros: OUTPUT_PRICE },
    { dim: 'model', match: match('cache_write_tokens'), unit: 'token', priceMicros: CACHE_WRITE_PRICE },
    { dim: 'model', match: match('cache_read_tokens'), unit: 'token', priceMicros: CACHE_READ_PRICE },
  ];
}

/** True when the card already carries a model line for this exact match tuple. */
function hasLine(lines, candidate) {
  return lines.some((l) => l?.dim === 'model'
    && l?.match?.technology === candidate.match.technology
    && l?.match?.provider === candidate.match.provider
    && l?.match?.detail === candidate.match.detail
    && l?.match?.unit === candidate.match.unit);
}

async function main() {
  if (!process.env.POSTGRES_HOST) {
    throw new Error('POSTGRES_* not set — is .env present? (select one with -p /path/to/.env)');
  }
  console.log(`applying against postgres ${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DB}`);
  await client.connect();

  // 1. Target rate name: env > defaultRateName Metadata singleton > 'default'.
  let rateName = process.env.RATE_NAME;
  if (!rateName) {
    const md = await client.query(`SELECT value FROM metadata WHERE key = 'defaultRateName'`);
    const v = md.rows[0]?.value;
    rateName = (typeof v === 'string' && v) ? v : 'default';
  }

  // 2. The card version covering now(); interval is [start_date, end_date).
  const found = await client.query(
    `SELECT id, name, start_date, end_date, currency, description, detail FROM rate_cards
     WHERE name = $1 AND start_date <= now() AND (end_date IS NULL OR end_date > now())
     ORDER BY start_date DESC LIMIT 1`,
    [rateName],
  );
  if (!found.rows.length) {
    throw new Error(`no rate card "${rateName}" covers now() — create the default card first`);
  }
  const card = found.rows[0];
  const lines = Array.isArray(card.detail?.lines) ? card.detail.lines : [];

  const additions = MODELS.flatMap((m) => modelLines(m)).filter((l) => !hasLine(lines, l));
  if (!additions.length) {
    console.log(`rate card "${rateName}" (id ${card.id}) already carries all ${MODELS.join(', ')} lines — nothing to do`);
    await client.end();
    return;
  }
  const detail = { ...card.detail, lines: [...lines, ...additions] };

  // 3. Referenced card versions are immutable (see the beforeUpdate guard in
  //    lib/database.js): supersede instead of editing in place. The check runs
  //    INSIDE the transaction with the card row locked, so a concurrent cost run
  //    cannot reference the card between the check and the in-place UPDATE.
  await client.query('BEGIN');
  try {
    await client.query(`SELECT id FROM rate_cards WHERE id = $1 FOR UPDATE`, [card.id]);
    const referenced = await client.query(
      `SELECT id FROM usage_records WHERE rate_name = $1 AND rate_card_start = $2 LIMIT 1`,
      [card.name, card.start_date],
    );
    if (referenced.rows.length) {
      const upd = await client.query(
        `UPDATE rate_cards SET end_date = now(), updated_at = now() WHERE id = $1 RETURNING end_date`,
        [card.id],
      );
      await client.query(
        `INSERT INTO rate_cards (name, start_date, end_date, currency, detail, description, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), now())`,
        [card.name, upd.rows[0].end_date, card.end_date, card.currency, JSON.stringify(detail),
          card.description],
      );
      console.log(`card "${rateName}" (id ${card.id}) is referenced by costed usage — superseded with a new version`);
    } else {
      await client.query(
        `UPDATE rate_cards SET detail = $2::jsonb, updated_at = now() WHERE id = $1`,
        [card.id, JSON.stringify(detail)],
      );
      console.log(`card "${rateName}" (id ${card.id}) updated in place (unreferenced)`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  additions.forEach((l) => console.log(`  + ${l.match.detail} ${l.match.unit} @ ${l.priceMicros} micro-pence/token`));
  await client.end();
}

main().catch(async (e) => {
  console.error('rate-line seeding failed:', e?.message || e);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
});
