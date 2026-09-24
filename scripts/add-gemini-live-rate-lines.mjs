/**
 * Idempotently add the Gemini Live rate lines to the platform default rate card
 * and to every bespoke card that prices models. The Gemini Live rows were
 * renamed from `google/gemini-2.0-flash-exp` (a model Google shut down on
 * 2025-12-09) to `google/gemini-2.5-flash-native-audio-preview-12-2025`, the
 * model both workers actually run, and usage rows now carry the new id. Rate
 * lines match `detail` exactly (lib/rates.js), so without lines for the new id
 * those rows resolve `costStatus:'no_line'` and bill nothing.
 *
 *   node scripts/add-gemini-live-rate-lines.mjs                   # from the repo root
 *   node scripts/add-gemini-live-rate-lines.mjs -p .env.staging   # another environment
 *   DRY_RUN=1 node scripts/add-gemini-live-rate-lines.mjs ...     # print the plan, write nothing
 *
 * Per target card it adds, when missing, the three token lines the worker
 * meters (`input_tokens`, `output_tokens`, `cache_read_tokens`) for provider
 * `google` and detail `google/gemini-2.5-flash-native-audio-preview-12-2025`.
 * Lines already present are left untouched, so re-running is a no-op. The old
 * `gemini-2.0-flash-exp` lines are left in place: rows already costed are
 * frozen, and a LiveKit agent still saved on the old id reports it.
 *
 * Pricing (micro-pence per token, the USD-per-million list digits rule the
 * cards use; see scripts/add-sonnet5-rate-lines.mjs): Google lists the model at
 * $0.50 (text) or $3.00 (audio) per million input tokens and $2.00 (text) or
 * $12.00 (audio) per million output tokens. The worker reports audio and text
 * tokens together, so the audio prices are used: a voice call is almost all
 * audio in and audio out. Google lists no context-caching price for this model;
 * cache reads take the 10% of input that Gemini 2.5 charges for cached text.
 * Each card prices its models at one factor of the list digits, read from the
 * card's Sonnet 5 input line as scripts/add-xai-rate-lines.mjs does, or
 * GEMINI_LIVE_PRICE_FACTOR. GEMINI_LIVE_INPUT_PRICE_MICROS,
 * GEMINI_LIVE_OUTPUT_PRICE_MICROS and GEMINI_LIVE_CACHE_READ_PRICE_MICROS
 * override the three prices outright.
 *
 * Target cards: the default card ($RATE_NAME, else the `defaultRateName`
 * Metadata singleton, else 'default') plus every other card whose covering
 * version carries at least one `dim: 'model'` line. A version already referenced
 * by costed usage is SUPERSEDED (end-dated at now, new version inserted with the
 * extra lines) rather than edited, mirroring the beforeUpdate guard in
 * lib/database.js.
 *
 * Self-contained: loads ./.env and talks to Postgres directly (no app boot).
 */
import { pathToFileURL } from 'node:url';
import { hasLine, priceFactorFor, round2sf } from './add-xai-rate-lines.mjs';

export const PROVIDER = 'google';
export const DETAIL = 'google/gemini-2.5-flash-native-audio-preview-12-2025';

/** Google's audio list prices per million tokens, as micro-pence per token. */
export const LIST_PRICES = { input: 3, output: 12, cacheRead: 0.3 };

/** The card's factor over list prices: GEMINI_LIVE_PRICE_FACTOR, else the Sonnet 5 reference, else 1. */
export function factorFor(lines, env = process.env) {
  if (env.GEMINI_LIVE_PRICE_FACTOR) return Number(env.GEMINI_LIVE_PRICE_FACTOR);
  // An empty env so the xAI override variable is not consulted.
  return priceFactorFor(lines, {});
}

/** The three prices for one card: the env overrides, else the list prices scaled by `factor`. */
export function pricesFor(env = process.env, factor = 1) {
  // The raw list digits are exact; only a scaled price is rounded.
  const scaled = (price) => (factor === 1 ? price : round2sf(price * factor));
  const num = (name, fallback) => (env[name] ? Number(env[name]) : scaled(fallback));
  return {
    input: num('GEMINI_LIVE_INPUT_PRICE_MICROS', LIST_PRICES.input),
    output: num('GEMINI_LIVE_OUTPUT_PRICE_MICROS', LIST_PRICES.output),
    cacheRead: num('GEMINI_LIVE_CACHE_READ_PRICE_MICROS', LIST_PRICES.cacheRead),
  };
}

/** The three token lines (the shape lib/rates.js matches). */
export function geminiLiveLines(prices) {
  const match = (unit) => ({ technology: 'llm', provider: PROVIDER, detail: DETAIL, unit });
  return [
    { dim: 'model', match: match('input_tokens'), unit: 'token', priceMicros: prices.input },
    { dim: 'model', match: match('output_tokens'), unit: 'token', priceMicros: prices.output },
    { dim: 'model', match: match('cache_read_tokens'), unit: 'token', priceMicros: prices.cacheRead },
  ];
}

/** True when the card prices at least one model. */
export function pricesModels(lines) {
  return (lines || []).some((l) => l?.dim === 'model');
}

/** The lines to add to one card, minus those already present. Pure, for tests. */
export function geminiLiveAdditions(lines, { env = process.env, factor = 1 } = {}) {
  return geminiLiveLines(pricesFor(env, factor)).filter((l) => !hasLine(lines, l));
}

async function main() {
  const pg = (await import('pg')).default;
  const { loadEnv } = await import('./env.mjs');
  loadEnv();
  if (!process.env.POSTGRES_HOST) {
    throw new Error('POSTGRES_* not set, is .env present? (select one with -p /path/to/.env)');
  }
  const dryRun = Boolean(process.env.DRY_RUN);
  for (const name of ['GEMINI_LIVE_PRICE_FACTOR', 'GEMINI_LIVE_INPUT_PRICE_MICROS', 'GEMINI_LIVE_OUTPUT_PRICE_MICROS', 'GEMINI_LIVE_CACHE_READ_PRICE_MICROS']) {
    if (process.env[name] && !Number.isFinite(Number(process.env[name]))) {
      throw new Error(`${name} must be a number`);
    }
  }

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
      || pricesModels(Array.isArray(c.detail?.lines) ? c.detail.lines : []));
    if (!cards.some((c) => c.name === rateName)) {
      throw new Error(`no rate card "${rateName}" covers now(), create the default card first`);
    }

    for (const card of cards) {
      const lines = Array.isArray(card.detail?.lines) ? card.detail.lines : [];
      const factor = factorFor(lines);
      const additions = geminiLiveAdditions(lines, { factor });
      if (!additions.length) {
        console.log(`rate card "${card.name}" (id ${card.id}) already carries every Gemini Live line, nothing to do`);
        continue;
      }
      console.log(`card "${card.name}": token lines at ${factor} of list`);
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
      additions.forEach((l) => console.log(`  + ${l.match.detail} ${l.match.unit} @ ${l.priceMicros} micro-pence/${l.unit}`));
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
