/**
 * Idempotently add the Neuphonic TTS rate lines (docs/neuphonic.md) to the
 * platform default rate card and to every other card that prices TTS. Without
 * them `tts|neuphonic` usage rows resolve `costStatus:'no_line'` and bill nothing.
 *
 *   node scripts/add-neuphonic-rate-lines.mjs                   # from the repo root
 *   node scripts/add-neuphonic-rate-lines.mjs -p .env.staging   # another environment
 *   DRY_RUN=1 node scripts/add-neuphonic-rate-lines.mjs ...     # print the plan, write nothing
 *
 * Per target card it adds, when missing:
 *   - a `characters` line, priced per character, and
 *   - a zero `milliseconds` line priced per minute, so the audio-time row settles
 *     matched instead of `no_line`.
 * The cards price every TTS engine this way (per character, zero per minute).
 *
 * Pricing: Neuphonic publishes no per-character price, so each card's own
 * Cartesia character price is used (55 micro-pence on every staging and beta
 * card on 2026-09-22). NEUPHONIC_CHARACTER_PRICE_MICROS sets the price for every
 * card instead. A target card with no Cartesia character line and no override
 * stops the run before anything is written.
 *
 * Target cards: the default card ($RATE_NAME, else the `defaultRateName`
 * Metadata singleton, else 'default') plus every other card whose covering
 * version carries a TTS line for a TTS engine. A version already referenced by
 * costed usage is SUPERSEDED (end-dated at now, new version inserted with the
 * extra lines) rather than edited, mirroring the beforeUpdate guard in
 * lib/database.js.
 *
 * Self-contained: loads ./.env and talks to Postgres directly (no app boot).
 */
import { pathToFileURL } from 'node:url';
import { TTS_ENGINES } from '../lib/rate-components.js';
import { hasLine } from './add-xai-rate-lines.mjs';

export const PROVIDER = 'neuphonic';
export const REFERENCE_PROVIDER = 'cartesia';

/** The two Neuphonic lines (the shape every TTS engine has on the cards). */
export function neuphonicLines(characterPriceMicros) {
  return [
    { dim: 'tts', match: { technology: 'tts', provider: PROVIDER, unit: 'characters' }, unit: 'character', priceMicros: characterPriceMicros },
    { dim: 'tts', match: { technology: 'tts', provider: PROVIDER, unit: 'milliseconds' }, unit: 'minute', priceMicros: 0 },
  ];
}

/**
 * The character price for one card: NEUPHONIC_CHARACTER_PRICE_MICROS when set,
 * else the card's Cartesia character line, else undefined.
 */
export function characterPriceFor(lines, env = process.env) {
  if (env.NEUPHONIC_CHARACTER_PRICE_MICROS) return Number(env.NEUPHONIC_CHARACTER_PRICE_MICROS);
  const ref = (lines || []).find((l) => l?.dim === 'tts'
    && l?.match?.technology === 'tts'
    && l?.match?.provider === REFERENCE_PROVIDER
    && l?.match?.unit === 'characters'
    && typeof l?.priceMicros === 'number');
  return ref?.priceMicros;
}

/** True when the card prices at least one discrete TTS engine. */
export function pricesTts(lines) {
  return (lines || []).some((l) => l?.dim === 'tts' && TTS_ENGINES.includes(l?.match?.provider));
}

/** The lines to add to one card, minus those already present. Pure, for tests. */
export function neuphonicAdditions(lines, characterPriceMicros) {
  return neuphonicLines(characterPriceMicros).filter((l) => !hasLine(lines, l));
}

async function main() {
  const pg = (await import('pg')).default;
  const { loadEnv } = await import('./env.mjs');
  loadEnv();
  if (!process.env.POSTGRES_HOST) {
    throw new Error('POSTGRES_* not set, is .env present? (select one with -p /path/to/.env)');
  }
  const dryRun = Boolean(process.env.DRY_RUN);
  if (process.env.NEUPHONIC_CHARACTER_PRICE_MICROS && !Number.isFinite(Number(process.env.NEUPHONIC_CHARACTER_PRICE_MICROS))) {
    throw new Error('NEUPHONIC_CHARACTER_PRICE_MICROS must be a number (micro-pence per character)');
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
      || pricesTts(Array.isArray(c.detail?.lines) ? c.detail.lines : []));
    if (!cards.some((c) => c.name === rateName)) {
      throw new Error(`no rate card "${rateName}" covers now(), create the default card first`);
    }

    // Plan every card before writing any: a missing reference price aborts the run.
    const plans = [];
    const missing = [];
    for (const card of cards) {
      const lines = Array.isArray(card.detail?.lines) ? card.detail.lines : [];
      const price = characterPriceFor(lines);
      if (price === undefined) {
        missing.push(card.name);
        continue;
      }
      plans.push({ card, lines, additions: neuphonicAdditions(lines, price) });
    }
    if (missing.length) {
      throw new Error(
        `card${missing.length > 1 ? 's' : ''} ${missing.map((n) => `"${n}"`).join(', ')} carry no Cartesia character line to copy `
        + 'the Neuphonic price from; set NEUPHONIC_CHARACTER_PRICE_MICROS (micro-pence per character)');
    }

    for (const { card, lines, additions } of plans) {
      if (!additions.length) {
        console.log(`rate card "${card.name}" (id ${card.id}) already carries both Neuphonic lines, nothing to do`);
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
      additions.forEach((l) => console.log(`  + tts|${l.match.provider} ${l.match.unit} @ ${l.priceMicros} micro-pence/${l.unit}`));
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
