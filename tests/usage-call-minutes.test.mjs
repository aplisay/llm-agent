import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, Agent, Instance, Call, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

describe('Call.end() records a finalised voice-minute usage row', () => {
  let orgId, userId, agentId, instanceId;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    orgId = randomUUID();
    userId = randomUUID();
    agentId = randomUUID();
    instanceId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Minutes Org' });
    await User.create({
      id: userId, name: 'Minutes User', email: `min-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgId,
    });
    // validate:false skips the heavy handler/voice validation (irrelevant here).
    await Agent.create(
      { id: agentId, name: 'Minutes Agent', modelName: 'livekit:test-model', userId, organisationId: orgId },
      { validate: false },
    );
    await Instance.create({ id: instanceId, agentId, type: 'livekit', userId, organisationId: orgId });
  }, 30000);

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await Organisation.destroy({ where: { id: orgId } }); // cascades user/agent/instance/call
    await teardownRealDatabase();
  }, 30000);

  it('writes a voice/milliseconds row finalised at call end', async () => {
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId,
      calledId: '441234567890', callerId: '447700900000',
      platform: 'livekit', modelName: 'livekit:test-model',
    });
    call.startedAt = new Date(Date.now() - 65_000);
    await call.end();

    const rows = await UsageRecord.findAll({ where: { callId: call.id, technology: 'voice' } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.unit).toBe('milliseconds');
    expect(row.finalised).toBe(true);
    expect(row.provider).toBe('livekit');
    expect(row.detail).toBe('livekit:test-model');
    expect(row.media).toBe('telephony');
    expect(Number(row.quantity)).toBeGreaterThanOrEqual(60_000);
    expect(row.sessionId).toBe(call.id);
  });

  it('cascades the usage row when the call is deleted', async () => {
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId,
      calledId: '441234567890', callerId: '447700900000',
      platform: 'livekit', modelName: 'livekit:test-model',
    });
    call.startedAt = new Date(Date.now() - 30_000);
    await call.end();
    expect(await UsageRecord.count({ where: { callId: call.id } })).toBe(1);

    await call.destroy();
    expect(await UsageRecord.count({ where: { callId: call.id } })).toBe(0);
  });

  it('stamps media=webrtc on a browser (WebRTC) call voice row', async () => {
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId,
      calledId: 'WebRTC', callerId: 'WebRTC',
      platform: 'livekit', modelName: 'livekit:test-model',
    });
    call.startedAt = new Date(Date.now() - 20_000);
    await call.end();
    const row = await UsageRecord.findOne({ where: { callId: call.id, technology: 'voice' } });
    expect(row.media).toBe('webrtc');
  });

  it("Call.mediaFromIds classifies by the leg's own ids", () => {
    expect(Call.mediaFromIds('WebRTC', 'WebRTC')).toBe('webrtc');
    expect(Call.mediaFromIds('447700900000', '441234567890')).toBe('telephony');
    expect(Call.mediaFromIds('WebRTC', '441234567890')).toBe('webrtc');
    expect(Call.mediaFromIds(null, null)).toBeNull();
  });

  it('persisted startedAt survives findByPk + Call.end() -> duration + voice row (repro)', async () => {
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId,
      calledId: 'WebRTC', callerId: 'WebRTC', platform: 'livekit', modelName: 'livekit:test-model',
    });
    call.startedAt = new Date(Date.now() - 30_000);
    await call.save();
    // Simulate the /call/:id/end endpoint: fresh load, then end (NOT the same instance).
    const fresh = await Call.findByPk(call.id);
    expect(fresh.startedAt).toBeTruthy();
    await fresh.end();
    const reloaded = await Call.findByPk(call.id);
    expect(Number(reloaded.duration)).toBeGreaterThan(0);
    const voice = await UsageRecord.findOne({ where: { callId: call.id, technology: 'voice' } });
    expect(voice).toBeTruthy();
  });

  it("GET /api/usage?callId= returns only that call's per-call rows", async () => {
    const silent = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child() { return silent; } };
    const GET = (await import('../api/paths/usage.js')).default(silent).GET;
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId,
      calledId: '441234567890', callerId: '447700900000',
      platform: 'livekit', modelName: 'livekit:test-model',
    });
    call.startedAt = new Date(Date.now() - 45_000);
    await call.end();

    const req = { query: { callId: call.id }, log: silent };
    const res = {
      locals: { user: { role: 'owner', id: userId, organisationId: orgId } },
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      send(b) { this.body = b; return this; },
      json(b) { this.body = b; return this; },
    };
    await GET(req, res);

    const usage = res.body?.usage || [];
    const voice = usage.filter((u) => u.technology === 'voice');
    expect(voice).toHaveLength(1);
    expect(voice[0].provider).toBe('livekit');
    expect(Number(voice[0].quantity)).toBeGreaterThanOrEqual(40_000);
  });
});
