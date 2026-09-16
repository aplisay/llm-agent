// OpenAI Responses usage reaches the ledger with cache writes as their own
// row, split out of input_tokens. See #309.
import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, databaseStarted,
} from './setup/database-test-wrapper.js';
import { recordLlmTokens } from '../lib/usage.js';
import { randomUUID } from 'crypto';

process.env.OPENAI_API_KEY ||= 'test-key';
const { default: OpenAi } = await import('../lib/models/openai.js');

const silentLog = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {},
  child: () => silentLog,
};

const driverReturning = (usage) => {
  const oa = new OpenAi({
    logger: silentLog,
    user: 'test',
    prompt: 'You are a test agent.',
    options: { maxTokens: 256 },
    model: 'text:openai/gpt-5.6-luna',
    modelName: 'text:openai/gpt-5.6-luna',
    mcpServers: [],
    keys: [],
  });
  const final = {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    usage,
  };
  oa.client = {
    responses: {
      stream: () => ({
        on() { return this; },
        abort() {},
        finalResponse: async () => final,
      }),
    },
  };
  return oa;
};

describe('OpenAI driver: cache write tokens in the usage ledger', () => {
  let orgId, userId;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    orgId = randomUUID();
    userId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Cache Write Test Org' });
    await User.create({
      id: userId, name: 'Cache Write Test User', email: `cache-write-${userId}@example.com`,
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

  const rowsFor = async (usage) => {
    const round = await driverReturning(usage).rawCompletion('hello');
    const sessionId = randomUUID();
    const u = round.usage;
    await recordLlmTokens({
      sessionId, organisationId: orgId, userId, agentId: null,
      provider: u.provider, model: u.model,
      inputTokens: u.inputTokens, outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens,
      log: silentLog,
    });
    const rows = await UsageRecord.findAll({ where: { sessionId } });
    return { round, byUnit: Object.fromEntries(rows.map((r) => [r.unit, Number(r.quantity)])) };
  };

  test('cache_write_tokens gives a cache_write_tokens row and leaves input_tokens disjoint', async () => {
    // A live gpt-5.6-luna second turn: 2828 = 3 uncached + 2808 read + 17 written.
    const { round, byUnit } = await rowsFor({
      input_tokens: 2828,
      output_tokens: 21,
      input_tokens_details: { cached_tokens: 2808, cache_write_tokens: 17 },
    });
    expect(round.usage).toEqual({
      provider: 'openai', model: 'gpt-5.6-luna',
      inputTokens: 3, outputTokens: 21, cacheReadTokens: 2808, cacheWriteTokens: 17,
    });
    expect(byUnit).toEqual({
      input_tokens: 3, output_tokens: 21, cache_read_tokens: 2808, cache_write_tokens: 17,
    });
  });

  test('usage without cache_write_tokens still reports 0 and records no cache_write_tokens row', async () => {
    const { round, byUnit } = await rowsFor({
      input_tokens: 100,
      output_tokens: 9,
      input_tokens_details: { cached_tokens: 40 },
    });
    expect(round.usage).toMatchObject({ inputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0 });
    expect(byUnit).toEqual({ input_tokens: 60, output_tokens: 9, cache_read_tokens: 40 });
  });
});
