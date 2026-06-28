import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

const mockLogger = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {},
  child: () => mockLogger,
};

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; return res; };
  return res;
}

describe('Agent DB Usage ingest endpoint (POST /api/agent-db/usage)', () => {
  let POST, orgId, userId;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    const mod = await import('../api/paths/agent-db/usage.js');
    POST = mod.default(mockLogger).POST;

    orgId = randomUUID();
    userId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Ingest Test Org' });
    await User.create({
      id: userId, name: 'Ingest Test User', email: `ingest-${userId}@example.com`,
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

  afterEach(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
  });

  it('records a single usage meter (201)', async () => {
    const req = { body: {
      sessionId: 'call-a', callId: null, organisationId: orgId, userId,
      technology: 'llm', provider: 'anthropic', detail: 'claude-opus-4-8', unit: 'input_tokens', quantity: 321,
    } };
    const res = mockRes();
    await POST(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.recorded).toBe(1);
    const rows = await UsageRecord.findAll({ where: { sessionId: 'call-a' } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quantity)).toBe(321);
  });

  it('records a batch via { records: [...] }', async () => {
    const req = { body: { records: [
      { sessionId: 'call-b', organisationId: orgId, userId, technology: 'llm', detail: 'm', unit: 'input_tokens', quantity: 10 },
      { sessionId: 'call-b', organisationId: orgId, userId, technology: 'llm', detail: 'm', unit: 'output_tokens', quantity: 4 },
      { sessionId: 'call-b', organisationId: orgId, userId, technology: 'tts', provider: 'deepgram', detail: 'aura', unit: 'characters', quantity: 88 },
    ] } };
    const res = mockRes();
    await POST(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.recorded).toBe(3);
    const rows = await UsageRecord.findAll({ where: { sessionId: 'call-b' } });
    expect(rows).toHaveLength(3);
  });

  it("updates an existing meter in place on a second 'set' post", async () => {
    const make = (quantity) => ({ body: {
      sessionId: 'call-c', organisationId: orgId, userId,
      technology: 'tts', provider: 'elevenlabs', detail: 'eleven_turbo_v2', unit: 'characters', quantity, mode: 'set',
    } });
    await POST(make(40), mockRes());
    await POST(make(140), mockRes());
    const rows = await UsageRecord.findAll({ where: { sessionId: 'call-c' } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quantity)).toBe(140);
  });

  it('rejects an invalid record (400) and records nothing', async () => {
    const req = { body: { sessionId: 'call-d', organisationId: orgId, userId, technology: 'llm' /* missing unit + quantity */ } };
    const res = mockRes();
    await POST(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    const rows = await UsageRecord.findAll({ where: { sessionId: 'call-d' } });
    expect(rows).toHaveLength(0);
  });
});
