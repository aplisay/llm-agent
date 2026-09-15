/**
 * Idempotently add the xAI Grok rate lines (docs/grok.md) to the platform
 * default rate card and to every bespoke card that prices models. Without
 * them Grok usage rows resolve `costStatus:'no_line'` and bill nothing.
 *
 *   node scripts/add-xai-rate-lines.mjs        # from the repo root
 *
 * What it does, per target card:
 *   1. Finds the card version covering now().
 *   2. Adds a `voice` minute line per Grok voice row at the price of that
 *      card's existing Ultravox minute line (read from the card), a zero
 *      `tts` minute line per bundled provider (ultravox, openai, xai: the
 *      speech a realtime model synthesises itself, which the Pipecat worker
 *      meters under the model's vendor), and `input_tokens`, `output_tokens`
 *      and `cache_read_tokens` lines per Grok text model. Lines already
 *      present are left untouched, so re-running is a no-op.
 *   3. Honours the card-immutability rule: a version already referenced by
 *      costed usage is SUPERSEDED (end-dated at now, new version inserted with
 *      the extra lines) instead of edited in place, mirroring the beforeUpdate
 *      guard in lib/database.js.
 *
 * Target cards: the default card ($RATE_NAME, else the `defaultRateName`
 * Metadata singleton, else 'default') plus every other card name whose
 * covering version carries at least one `dim: 'model'` line. A target card
 * with no Ultravox minute line stops the run before anything is written,
 * unless XAI_VOICE_PRICE_MICROS names the minute price to use instead.
 *
 * Pricing (micro-pence per token; override via env):
 *   xAI lists grok-4.6 at $2.00 / $0.50 / $6.00 per MTok (input / cached /
 *   output) and grok-4.3 and both grok-4.20-0309 models at $1.25 / $0.20 /
 *   $2.50. By the Sonnet 5 convention (scripts/add-sonnet5-rate-lines.mjs)
 *   the defaults are the same digits in GBP micro-pence per token, which is
 *   the platform's usual margin at typical FX. XAI_INPUT_PRICE_MICROS,
 *   XAI_OUTPUT_PRICE_MICROS and XAI_CACHE_READ_PRICE_MICROS override the base
 *   prices for every model. MODELS (comma-separated bare model ids) selects
 *   the text models; VOICE_MODELS (comma-separated full model names) the voice
 *   rows, default the Pipecat row only until the LiveKit row exists.
 *
 * Self-contained: loads ./.env and talks to Postgres directly (no app boot).
 */
import { pathToFileURL } from 'node:url';
import { BUNDLED_TTS_PROVIDERS } from '../lib/rate-components.js';

export const DEFAULT_TEXT_MODELS = ['grok-4.6', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning'];
export const DEFAULT_VOICE_MODELS = ['pipecat:xai/grok-voice-think-fast-2.0'];

/** List prices per million tokens, as micro-pence per token (the Sonnet 5 digits rule). */
export const TEXT_LIST_PRICES = {
  'grok-4.6': { input: 2, cacheRead: 0.5, output: 6 },
  'grok-4.3': { input: 1.25, cacheRead: 0.2, output: 2.5 },
  'grok-4.20-0309-reasoning': { input: 1.25, cacheRead: 0.2, output: 2.5 },
  'grok-4.20-0309-non-reasoning': { input: 1.25, cacheRead: 0.2, output: 2.5 },
};

/** Prices for one text model: the env overrides, else the list table, else grok-4.3's. */
export function textPricesFor(model, env = process.env) {
  const base = TEXT_LIST_PRICES[model] || TEXT_LIST_PRICES['grok-4.3'];
  const num = (name, fallback) => (env[name] ? Number(env[name]) : fallback);
  return {
    input: num('XAI_INPUT_PRICE_MICROS', base.input),
    output: num('XAI_OUTPUT_PRICE_MICROS', base.output),
    cacheRead: num('XAI_CACHE_READ_PRICE_MICROS', base.cacheRead),
  };
}

/** The three token lines a text model needs on the card (matches lib/rates.js line shape). */
export function textModelLines(model, prices) {
  const match = (unit) => ({ technology: 'llm', provider: 'xai', detail: `xai/${model}`, unit });
  return [
    { dim: 'model', match: match('input_tokens'), unit: 'token', priceMicros: prices.input },
    { dim: 'model', match: match('output_tokens'), unit: 'token', priceMicros: prices.output },
    { dim: 'model', match: match('cache_read_tokens'), unit: 'token', priceMicros: prices.cacheRead },
  ];
}

/** The per-minute voice line for a Grok voice row (the Ultravox and GPT-Live shape). */
export function voiceModelLine(modelName, priceMicros) {
  return { dim: 'model', match: { technology: 'voice', detail: modelName }, unit: 'minute', priceMicros };
}

/**
 * The zero lines for the speech a realtime model synthesises itself: the
 * Pipecat worker meters it as `tts` audio under the model's vendor, and
 * without a line those rows settle `no_line` and read as "not priced" beside
 * the model charge that already covers them. One per bundled provider
 * (BUNDLED_TTS_PROVIDERS in lib/rate-components.js: ultravox, openai, xai),
 * not only xai, because the worker's attribution changed for all three in
 * the same change.
 */
export function bundledTtsLines(providers = BUNDLED_TTS_PROVIDERS) {
  return providers.map((provider) => ({
    dim: 'tts', match: { technology: 'tts', provider }, unit: 'minute', priceMicros: 0,
  }));
}

/**
 * The price of the card's Ultravox minute line, preferring the row on the
 * same handler as `modelName` (`pipecat:` or `livekit:`), else any Ultravox
 * minute line; undefined when the card has none.
 */
export function ultravoxMinutePrice(lines, modelName = '') {
  const handler = String(modelName).split(':')[0];
  const candidates = (lines || []).filter((l) => l?.dim === 'model'
    && l?.unit === 'minute'
    && l?.match?.technology === 'voice'
    && /ultravox/i.test(String(l?.match?.detail || ''))
    && typeof l?.priceMicros === 'number');
  const same = candidates.find((l) => String(l.match.detail).startsWith(`${handler}:`));
  return (same || candidates[0])?.priceMicros;
}

/** True when the card already carries a line for this exact dim and match tuple. */
export function hasLine(lines, candidate) {
  return (lines || []).some((l) => l?.dim === candidate.dim
    && l?.match?.technology === candidate.match.technology
    && (l?.match?.provider ?? null) === (candidate.match.provider ?? null)
    && (l?.match?.detail ?? null) === (candidate.match.detail ?? null)
    && (l?.match?.unit ?? null) === (candidate.match.unit ?? null)
    && (candidate.unit !== 'minute' || l?.unit === 'minute'));
}

/**
 * The lines to add to one card: voice minute lines at `voicePrice`, the zero
 * lines for every bundled provider's own speech, and the text token lines,
 * minus those already present. Pure, so a fixture card can be checked in a
 * test.
 */
export function xaiAdditions(lines, { textModels = DEFAULT_TEXT_MODELS, voiceModels = DEFAULT_VOICE_MODELS, voicePrice, env = process.env } = {}) {
  const wanted = [
    ...voiceModels.map((name) => voiceModelLine(name, voicePrice)),
    ...bundledTtsLines(),
    ...textModels.flatMap((model) => textModelLines(model, textPricesFor(model, env))),
  ];
  return wanted.filter((l) => !hasLine(lines, l));
}

async function main() {
  const pg = (await import('pg')).default;
  const { loadEnv } = await import('./env.mjs');
  loadEnv();
  if (!process.env.POSTGRES_HOST) {
    throw new Error('POSTGRES_* not set, is .env present? (select one with -p /path/to/.env)');
  }
  const textModels = (process.env.MODELS || DEFAULT_TEXT_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
  const voiceModels = (process.env.VOICE_MODELS || DEFAULT_VOICE_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
  const voiceOverride = process.env.XAI_VOICE_PRICE_MICROS ? Number(process.env.XAI_VOICE_PRICE_MICROS) : undefined;

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
  console.log(`applying against postgres ${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DB}`);
  await client.connect();
  try {
    // 1. Target names: the default card plus every card that prices models.
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

    // 2. Plan every card before writing any: a missing Ultravox price aborts the run.
    const plans = [];
    const missing = [];
    for (const card of cards) {
      const lines = Array.isArray(card.detail?.lines) ? card.detail.lines : [];
      const voicePrice = voiceOverride ?? ultravoxMinutePrice(lines, voiceModels[0]);
      if (voiceModels.length && voicePrice === undefined) {
        missing.push(card.name);
        continue;
      }
      plans.push({ card, lines, additions: xaiAdditions(lines, { textModels, voiceModels, voicePrice }) });
    }
    if (missing.length) {
      throw new Error(
        `card${missing.length > 1 ? 's' : ''} ${missing.map((n) => `"${n}"`).join(', ')} carry no Ultravox minute line to copy `
        + 'the Grok voice price from; set XAI_VOICE_PRICE_MICROS (micro-pence per minute) or VOICE_MODELS= to skip the voice rows');
    }

    for (const { card, lines, additions } of plans) {
      if (!additions.length) {
        console.log(`rate card "${card.name}" (id ${card.id}) already carries every xAI line, nothing to do`);
        continue;
      }
      const detail = { ...card.detail, lines: [...lines, ...additions] };
      // 3. Referenced versions are immutable: supersede instead of editing in
      //    place. The check runs inside the transaction with the row locked.
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
      additions.forEach((l) => console.log(`  + ${l.match.detail} ${l.match.unit || 'voice'} @ ${l.priceMicros} micro-pence/${l.unit}`));
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
