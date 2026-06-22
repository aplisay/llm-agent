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
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role: {}, organisationId: orgId,
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
});
