// Grok token rows from a text:xai agent and from a Pipecat pipeline carry
// different `detail` forms; both must price on the lines
// scripts/add-xai-rate-lines.mjs writes.
import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, databaseStarted,
} from './setup/database-test-wrapper.js';
import { recordLlmTokens } from '../lib/usage.js';
import { resolveRowCost } from '../lib/rates.js';
import { xaiAdditions } from '../scripts/add-xai-rate-lines.mjs';
import { randomUUID } from 'crypto';

process.env.XAI_API_KEY ||= 'test-key';
const { default: Xai } = await import('../lib/models/xai.js');

const silentLog = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {},
  child: () => silentLog,
};

const textDriverReturning = (usage) => {
  const grok = new Xai({
    logger: silentLog,
    user: 'test',
    prompt: 'You are a test agent.',
    options: { maxTokens: 256 },
    model: 'text:xai/grok-4.3',
    modelName: 'text:xai/grok-4.3',
    mcpServers: [],
    keys: [],
  });
  grok.client = { chat: { completions: { create: async () => ({
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
      yield { choices: [], usage };
    },
  }) } } };
  return grok;
};

// Priced like the staging cards: Sonnet 5 input at 2.2 gives the 0.7333 factor.
const sonnet = {
  dim: 'model', match: { technology: 'llm', provider: 'anthropic', detail: 'claude-sonnet-5', unit: 'input_tokens' },
  unit: 'token', priceMicros: 2.2,
};
const card = { detail: { lines: [sonnet, ...xaiAdditions([sonnet], { voiceModels: [], factor: 0.7333, env: {} })] } };
// The same card with only the roster-id lines, as the script wrote it before.
const rosterOnly = { detail: { lines: card.detail.lines.filter((l) => !String(l.match.detail).startsWith('grok-')) } };

describe('xAI rate lines price every Grok token row', () => {
  let orgId, userId;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    orgId = randomUUID();
    userId = randomUUID();
    await Organisation.create({ id: orgId, name: 'xAI Rate Lines Test Org' });
    await User.create({
      id: userId, name: 'xAI Rate Lines Test User', email: `xai-rate-lines-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner',
      organisationId: orgId,
    });
  }, 30000);

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await User.destroy({ where: { id: userId } });
    await Organisation.destroy({ where: { id: orgId } });
    await teardownRealDatabase();
  }, 30000);

  test('a text:xai agent records the bare model id, and its rows price on the card', async () => {
    const round = await textDriverReturning({
      prompt_tokens: 120, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 100 },
    }).rawCompletion('hello');
    expect(round.usage).toMatchObject({ provider: 'xai', model: 'grok-4.3' });

    const sessionId = randomUUID();
    const u = round.usage;
    await recordLlmTokens({
      sessionId, organisationId: orgId, userId, agentId: null,
      provider: u.provider, model: u.model,
      inputTokens: u.inputTokens, outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens,
      log: silentLog,
    });
    const rows = (await UsageRecord.findAll({ where: { sessionId } })).map((r) => r.get({ plain: true }));
    expect(rows.map((r) => r.detail)).toEqual(['grok-4.3', 'grok-4.3', 'grok-4.3']);

    const cost = Object.fromEntries(rows.map((r) => [r.unit, resolveRowCost(r, card)]));
    expect(Object.values(cost).map((c) => c.status)).toEqual(['matched', 'matched', 'matched']);
    // 20 uncached input at 0.92, 9 output at 1.8 and 100 cached at 0.15 micros (1e-6 GBP) per token.
    expect(cost.input_tokens.costMicros).toBe(18);
    expect(cost.output_tokens.costMicros).toBe(16);
    expect(cost.cache_read_tokens.costMicros).toBe(15);
    for (const r of rows) expect(resolveRowCost(r, rosterOnly).status).toBe('no_line');
  });

  test('a Pipecat pipeline row carries the roster id and prices the same as a text row', () => {
    // The Pipecat side of the row shape is pinned by agents/pipecat/tests/test_usage.py.
    for (const unit of ['input_tokens', 'output_tokens', 'cache_read_tokens']) {
      const pipeline = { technology: 'llm', provider: 'xai', detail: 'xai/grok-4.3', unit, quantity: 1000 };
      const text = { ...pipeline, detail: 'grok-4.3' };
      expect(resolveRowCost(pipeline, card).status).toBe('matched');
      expect(resolveRowCost(pipeline, card).costMicros).toBe(resolveRowCost(text, card).costMicros);
      expect(resolveRowCost(pipeline, rosterOnly).status).toBe('matched');
    }
  });
});
