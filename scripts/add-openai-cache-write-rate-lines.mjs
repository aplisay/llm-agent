/**
 * Idempotently add `cache_write_tokens` lines for the GPT-5.6 models to every
 * rate card that prices them. OpenAI and OpenRouter usage now reports GPT-5.6
 * cache writes on their own row instead of inside input_tokens (#309), and a
 * row with no line resolves `costStatus:'no_line'` and bills nothing.
 *
 *   node scripts/add-openai-cache-write-rate-lines.mjs [-p /path/to/.env] [--dry-run]
 *
 * For each card name, the version covering now() gets a cache_write_tokens line
 * beside each GPT-5.6 input_tokens line it carries for provider openai or
 * openrouter, in any detail form (gpt-5.6-terra, openai/gpt-5.6-terra,
 * openrouter/gpt-5.6-terra). The price is the input line times 1.25, OpenAI's
 * cache-write rate, rounded to two significant figures like the rest of the
 * card. Lines already present are left alone, so a rerun is a no-op. A version
 * that costed usage already references is superseded, as in add-xai-rate-lines.mjs.
 *
 * MODELS (comma-separated bare model ids) and CACHE_WRITE_MULTIPLIER override
 * the defaults. --dry-run prints the plan and writes nothing.
 */
import { pathToFileURL } from 'node:url';
import { hasLine, round2sf } from './add-xai-rate-lines.mjs';

export const DEFAULT_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
export const PROVIDERS = ['openai', 'openrouter'];
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** The model a line's detail names, bare or behind vendor segments, else undefined. */
export function modelForDetail(detail, models = DEFAULT_MODELS) {
  const d = String(detail || '');
  return models.find((m) => d === m || d.endsWith(`/${m}`));
}

export function cacheWritePrice(inputPrice, multiplier = CACHE_WRITE_MULTIPLIER) {
  // 0.022 * 1.25 is 0.027499999999999997, which would round to 0.027.
  return round2sf(Number((inputPrice * multiplier).toPrecision(12)));
}

/** The cache_write_tokens lines one card is missing. Pure, so a fixture card can be checked in a test. */
export function cacheWriteAdditions(lines, { models = DEFAULT_MODELS, multiplier = CACHE_WRITE_MULTIPLIER } = {}) {
  const additions = [];
  for (const line of lines || []) {
    if (line?.dim !== 'model' || line?.match?.technology !== 'llm' || line?.match?.unit !== 'input_tokens') continue;
    if (!PROVIDERS.includes(line.match.provider) || !modelForDetail(line.match.detail, models)) continue;
    if (typeof line.priceMicros !== 'number') continue;
    const candidate = {
      dim: 'model',
      match: { ...line.match, unit: 'cache_write_tokens' },
      unit: line.unit,
      priceMicros: cacheWritePrice(line.priceMicros, multiplier),
    };
    if (!hasLine(lines, candidate) && !hasLine(additions, candidate)) additions.push(candidate);
  }
  return additions;
}

async function main() {
  const pg = (await import('pg')).default;
  const { loadEnv } = await import('./env.mjs');
  loadEnv();
  if (!process.env.POSTGRES_HOST) {
    throw new Error('POSTGRES_* not set, is .env present? (select one with -p /path/to/.env)');
  }
  const dryRun = process.argv.includes('--dry-run');
  const models = (process.env.MODELS || DEFAULT_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
  const multiplier = process.env.CACHE_WRITE_MULTIPLIER ? Number(process.env.CACHE_WRITE_MULTIPLIER) : CACHE_WRITE_MULTIPLIER;

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
  console.log(`${dryRun ? 'planning (dry run) against' : 'applying against'} postgres ${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DB}`);
  await client.connect();
  try {
    const covering = await client.query(
      `SELECT DISTINCT ON (name) id, name, start_date, end_date, currency, description, detail FROM rate_cards
       WHERE start_date <= now() AND (end_date IS NULL OR end_date > now())
       ORDER BY name, start_date DESC`,
    );
    for (const card of covering.rows) {
      const lines = Array.isArray(card.detail?.lines) ? card.detail.lines : [];
      const additions = cacheWriteAdditions(lines, { models, multiplier });
      if (!additions.length) {
        console.log(`rate card "${card.name}" (id ${card.id}) needs no cache_write_tokens lines`);
        continue;
      }
      console.log(`rate card "${card.name}" (id ${card.id}) needs ${additions.length} line(s):`);
      additions.forEach((l) => console.log(`  + ${l.match.provider} ${l.match.detail} cache_write_tokens @ ${l.priceMicros} micro-pence/${l.unit}`));
      if (dryRun) continue;

      const detail = { ...card.detail, lines: [...lines, ...additions] };
      // Referenced versions are immutable: supersede instead of editing in
      // place. The check runs inside the transaction with the row locked.
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
          console.log(`  card "${card.name}" (id ${card.id}) is referenced by costed usage, superseded with a new version`);
        } else {
          await client.query(`UPDATE rate_cards SET detail = $2::jsonb, updated_at = now() WHERE id = $1`, [card.id, JSON.stringify(detail)]);
          console.log(`  card "${card.name}" (id ${card.id}) updated in place (unreferenced)`);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
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
