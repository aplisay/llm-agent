/**
 * Idempotently add the ElevenLabs Agents minute lines (docs/elevenlabs-agents.md)
 * to the platform default rate card and to every bespoke card that prices
 * models. Without them a call on an ElevenLabs Agents row resolves
 * `costStatus:'no_line'` and bills nothing.
 *
 *   node scripts/add-elevenlabs-rate-lines.mjs                               # from the repo root
 *   node scripts/add-elevenlabs-rate-lines.mjs -p .env.staging --dry-run     # print the plan, write nothing
 *
 * DRY_RUN=1 also selects the dry run.
 *
 * What it does, per target card:
 *   1. Finds the card version covering now().
 *   2. Adds a `voice` minute line per ElevenLabs Agents row (VOICE_MODELS, a
 *      comma-separated list of full model names, default every Pipecat row) at
 *      ELEVENLABS_VOICE_PRICE_MICROS micro-pence per minute. Without that
 *      override the price of the card's own Ultravox minute line is used as a
 *      placeholder, which is below what ElevenLabs charges: set the real price
 *      per card. Lines already present are left untouched, so re-running is a
 *      no-op. No `tts` line is added: the worker does not meter the agent's
 *      speech (a `tts|elevenlabs` row would be priced by the discrete TTS line).
 *   3. Honours the card-immutability rule: a version already referenced by
 *      costed usage is SUPERSEDED (end-dated at now, new version inserted with
 *      the extra lines) instead of edited in place, mirroring the beforeUpdate
 *      guard in lib/database.js.
 *
 * Target cards: the default card ($RATE_NAME, else the `defaultRateName`
 * Metadata singleton, else 'default') plus every other card name whose
 * covering version carries at least one `dim: 'model'` line.
 *
 * Self-contained: loads ./.env and talks to Postgres directly (no app boot).
 */
import { pathToFileURL } from 'node:url';
import { ELEVENLABS_AGENT_LLMS } from '../lib/elevenlabs-agents.js';
import { hasLine, ultravoxMinutePrice, voiceModelLine } from './add-xai-rate-lines.mjs';

export const DEFAULT_VOICE_MODELS = ELEVENLABS_AGENT_LLMS.map(({ id }) => `pipecat:elevenlabs/${id}`);

/**
 * The minute lines one card still lacks, at `voicePrice`. Pure, so a fixture
 * card can be checked in a test.
 */
export function elevenLabsAdditions(lines, { voiceModels = DEFAULT_VOICE_MODELS, voicePrice } = {}) {
  return voiceModels
    .map((name) => voiceModelLine(name, voicePrice))
    .filter((l) => !hasLine(lines, l));
}

async function main() {
  const pg = (await import('pg')).default;
  const { loadEnv } = await import('./env.mjs');
  loadEnv();
  if (!process.env.POSTGRES_HOST) {
    throw new Error('POSTGRES_* not set, is .env present? (select one with -p /path/to/.env)');
  }
  const voiceModels = (process.env.VOICE_MODELS || DEFAULT_VOICE_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
  const voiceOverride = process.env.ELEVENLABS_VOICE_PRICE_MICROS ? Number(process.env.ELEVENLABS_VOICE_PRICE_MICROS) : undefined;
  const dryRun = process.argv.includes('--dry-run') || Boolean(process.env.DRY_RUN);

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
      || (Array.isArray(c.detail?.lines) && c.detail.lines.some((l) => l?.dim === 'model')));
    if (!cards.some((c) => c.name === rateName)) {
      throw new Error(`no rate card "${rateName}" covers now(), create the default card first`);
    }

    // Plan every card before writing any: a card with no price to copy aborts the run.
    const plans = [];
    const missing = [];
    for (const card of cards) {
      const lines = Array.isArray(card.detail?.lines) ? card.detail.lines : [];
      const voicePrice = voiceOverride ?? ultravoxMinutePrice(lines, voiceModels[0]);
      if (voicePrice === undefined) {
        missing.push(card.name);
        continue;
      }
      console.log(`card "${card.name}": ElevenLabs Agents minute ${voicePrice} micro-pence`);
      plans.push({ card, lines, additions: elevenLabsAdditions(lines, { voiceModels, voicePrice }) });
    }
    if (missing.length) {
      throw new Error(
        `card${missing.length > 1 ? 's' : ''} ${missing.map((n) => `"${n}"`).join(', ')} carry no Ultravox minute line to copy `
        + 'a placeholder price from; set ELEVENLABS_VOICE_PRICE_MICROS (micro-pence per minute)');
    }

    for (const { card, lines, additions } of plans) {
      if (!additions.length) {
        console.log(`rate card "${card.name}" (id ${card.id}) already carries every ElevenLabs Agents line, nothing to do`);
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
      additions.forEach((l) => console.log(`  + ${l.match.detail} voice @ ${l.priceMicros} micro-pence/${l.unit}`));
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
