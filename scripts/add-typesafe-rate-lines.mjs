/**
 * Idempotently add the TypeSafe Jev rate lines (docs/typesafe-jev.md) to the
 * platform default rate card and to every other card that prices a text
 * model. Without them `llm|typesafe` usage rows resolve `costStatus:'no_line'`
 * and bill nothing.
 *
 *   node scripts/add-typesafe-rate-lines.mjs                   # from the repo root
 *   node scripts/add-typesafe-rate-lines.mjs -p .env.staging   # another environment
 *   DRY_RUN=1 node scripts/add-typesafe-rate-lines.mjs ...     # print the plan, write nothing
 *
 * Per target card it adds, when missing:
 *   - an `input_tokens` line priced per token, and
 *   - a zero `output_tokens` line, because the vendor reports output tokens
 *     (free of charge) and the row must settle matched rather than `no_line`.
 *
 * The lines match `{ technology: 'llm', provider: 'typesafe', detail: 'jev-1.13.0', unit }`:
 * `detail` is the id with the vendor segment stripped, the form every text
 * driver records (lib/models/llm.js) and lib/rates.js matches by exact equality.
 *
 * Pricing: the vendor lists USD 0.042 per million input tokens, output free.
 * priceMicros is in micros (1e-6 GBP, see lib/rates.js), so at 1.20 USD per
 * GBP that is 0.035 micros per token (GBP 0.035 per million tokens), the
 * default. TYPESAFE_INPUT_PRICE_MICROS sets the input price for every card
 * instead.
 *
 * Target cards: the default card ($RATE_NAME, else the `defaultRateName`
 * Metadata singleton, else 'default') plus every other card whose covering
 * version carries a token-priced model line. A version already referenced by
 * costed usage is SUPERSEDED (end-dated at now, new version inserted with the
 * extra lines) rather than edited, mirroring the beforeUpdate guard in
 * lib/database.js.
 *
 * Self-contained: loads ./.env and talks to Postgres directly (no app boot).
 */
import { pathToFileURL } from 'node:url';
import { hasLine } from './add-xai-rate-lines.mjs';

export const PROVIDER = 'typesafe';
export const MODEL = 'jev-1.13.0';
/** USD 0.042 per million input tokens at 1.20 USD per GBP, in micros (1e-6 GBP) per token. */
export const DEFAULT_INPUT_PRICE_MICROS = 0.035;

/** The two Jev lines: input priced per token, output free. */
export function typesafeLines(inputPriceMicros = DEFAULT_INPUT_PRICE_MICROS) {
  const match = (unit) => ({ technology: 'llm', provider: PROVIDER, detail: MODEL, unit });
  return [
    { dim: 'model', match: match('input_tokens'), unit: 'token', priceMicros: inputPriceMicros },
    { dim: 'model', match: match('output_tokens'), unit: 'token', priceMicros: 0 },
  ];
}

/** The input price: TYPESAFE_INPUT_PRICE_MICROS when set, else the vendor list price. */
export function inputPriceFor(env = process.env) {
  if (env.TYPESAFE_INPUT_PRICE_MICROS) return Number(env.TYPESAFE_INPUT_PRICE_MICROS);
  return DEFAULT_INPUT_PRICE_MICROS;
}

/** True when the card prices at least one text model by token. */
export function pricesTextModels(lines) {
  return (lines || []).some((l) => l?.dim === 'model' && l?.match?.technology === 'llm' && l?.unit === 'token');
}

/** The lines to add to one card, minus those already present. Pure, for tests. */
export function typesafeAdditions(lines, inputPriceMicros = DEFAULT_INPUT_PRICE_MICROS) {
  return typesafeLines(inputPriceMicros).filter((l) => !hasLine(lines, l));
}

async function main() {
  const pg = (await import('pg')).default;
  const { loadEnv } = await import('./env.mjs');
  loadEnv();
  if (!process.env.POSTGRES_HOST) {
    throw new Error('POSTGRES_* not set, is .env present? (select one with -p /path/to/.env)');
  }
  const dryRun = Boolean(process.env.DRY_RUN);
  if (process.env.TYPESAFE_INPUT_PRICE_MICROS && !Number.isFinite(Number(process.env.TYPESAFE_INPUT_PRICE_MICROS))) {
    throw new Error('TYPESAFE_INPUT_PRICE_MICROS must be a number (micros, 1e-6 GBP, per token)');
  }
  const price = inputPriceFor();

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
  console.log(`${dryRun ? 'planning (DRY_RUN) ' : 'applying '}against postgres ${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DB}`);
  await client.connect();
  try {
    let rateName = process.env.RATE_NAME;
    if (!rateName) {
      const md = await client.query(`SELECT value FROM metadata WHERE key = 'defaultRateName'`);
      const v = md.rows[0]?.value;
      rateName = (typeof v === 'string' && v) ? v : 'default';
    }
    const covering = await client.query(
      `SELECT DISTINCT ON (name) id, name, start_date, end_date, currency, description, detail FROM rate_cards
       WHERE start_date <= now() AND (end_date IS NULL OR end_date > now())
       ORDER BY name, start_date DESC`,
    );
    const cards = covering.rows.filter((c) => c.name === rateName
      || pricesTextModels(Array.isArray(c.detail?.lines) ? c.detail.lines : []));
    if (!cards.some((c) => c.name === rateName)) {
      throw new Error(`no rate card "${rateName}" covers now(), create the default card first`);
    }

    for (const card of cards) {
      const lines = Array.isArray(card.detail?.lines) ? card.detail.lines : [];
      const additions = typesafeAdditions(lines, price);
      if (!additions.length) {
        console.log(`rate card "${card.name}" (id ${card.id}) already carries both Jev lines, nothing to do`);
        continue;
      }
      const detail = { ...card.detail, lines: [...lines, ...additions] };
      if (dryRun) {
        console.log(`card "${card.name}" (id ${card.id}) would gain:`);
      } else {
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
              [card.name, upd.rows[0].end_date, card.end_date, card.currency, JSON.stringify(detail), card.description],
            );
            console.log(`card "${card.name}" (id ${card.id}) is referenced by costed usage, superseded with a new version`);
          } else {
            await client.query(`UPDATE rate_cards SET detail = $2::jsonb, updated_at = now() WHERE id = $1`, [card.id, JSON.stringify(detail)]);
            console.log(`card "${card.name}" (id ${card.id}) updated in place (unreferenced)`);
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
      additions.forEach((l) => console.log(`  + llm|${l.match.provider}|${l.match.detail} ${l.match.unit} @ ${l.priceMicros} micros/${l.unit}`));
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('rate-line seeding failed:', e?.message || e);
    process.exit(1);
  });
}
