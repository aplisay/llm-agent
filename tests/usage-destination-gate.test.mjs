import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, Agent, Instance, Call, Trunk, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// Phase-D3: recordUsageMinutes gates destination billing on Call.outboundTrunkId.
// A carried outbound leg on a trunk the org does NOT own freezes the dialled
// number as metadata.destinationRaw (the resolver's tariff anchor); an org-owned
// trunk, or no outbound trunk (inbound/webrtc/refer/registration), does not.

const PREFIX = `dg-test-${randomUUID()}-`;

describe('destination-billing gate in recordUsageMinutes (D3)', () => {
  let orgId; let userId; let agentId; let instanceId; let sharedTrunkId; let ownedTrunkId;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    orgId = randomUUID(); userId = randomUUID(); agentId = randomUUID(); instanceId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Gate Org' });
    await User.create({
      id: userId, name: 'Gate User', email: `g-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgId,
    });
    await Agent.create(
      { id: agentId, name: 'Gate Agent', modelName: 'livekit:test-model', userId, organisationId: orgId },
      { validate: false },
    );
    await Instance.create({ id: instanceId, agentId, type: 'livekit', userId, organisationId: orgId });

    // A shared (platform) outbound trunk the org does NOT own, and an org-owned one.
    sharedTrunkId = `${PREFIX}shared`;
    ownedTrunkId = `${PREFIX}owned`;
    await Trunk.create({ id: sharedTrunkId, name: 'Aplisay Outbound', outbound: true });
    const owned = await Trunk.create({ id: ownedTrunkId, name: 'Org BYO Trunk', outbound: true });
    const org = await Organisation.findByPk(orgId);
    await org.addTrunk(owned); // TrunkOrganisation(ownedTrunkId, orgId)
  }, 30000);

  afterEach(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await Call.destroy({ where: { organisationId: orgId } });
  });

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await Trunk.destroy({ where: { id: { [Op.like]: `${PREFIX}%` } } }); // cascades TrunkOrganisation
    await Organisation.destroy({ where: { id: orgId } });
    await teardownRealDatabase();
  }, 30000);

  const endBridgedLeg = async (over = {}) => {
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId,
      calledId: '447970123456', callerId: 'WebRTC',
      platform: 'livekit', modelName: 'telephony:bridged-call', ...over,
    });
    call.startedAt = new Date(Date.now() - 65_000);
    await call.end();
    return UsageRecord.findOne({ where: { callId: call.id, technology: 'voice' } });
  };

  it('persists Call.outboundTrunkId', async () => {
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId,
      platform: 'livekit', modelName: 'telephony:bridged-call', outboundTrunkId: sharedTrunkId,
    });
    expect((await Call.findByPk(call.id)).outboundTrunkId).toBe(sharedTrunkId);
  });

  it('stamps destinationRaw when the outbound trunk is NOT owned by the org', async () => {
    const row = await endBridgedLeg({ outboundTrunkId: sharedTrunkId });
    expect(row.metadata?.destinationRaw).toBe('447970123456');
  });

  it('does NOT stamp destinationRaw when the org OWNS the outbound trunk', async () => {
    const row = await endBridgedLeg({ outboundTrunkId: ownedTrunkId });
    expect(row.metadata?.destinationRaw).toBeUndefined();
  });

  it('does NOT stamp destinationRaw when there is no outbound trunk (inbound/webrtc/refer)', async () => {
    const row = await endBridgedLeg({ outboundTrunkId: null });
    expect(row.metadata?.destinationRaw).toBeUndefined();
  });
});
