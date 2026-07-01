import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, Agent, Instance, Call, Trunk, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// Phase-D3: recordUsageMinutes gates destination billing on Call.outboundTrunkId's
// Trunk.chargeable flag. A carried leg on one of OUR public/carrier trunks
// (chargeable=true) freezes the dialled number as metadata.destinationRaw (the
// resolver's tariff anchor); a non-chargeable trunk (customer PBX / BYO / inbound),
// or no outbound trunk (webrtc/refer), does not.

const PREFIX = `dg-test-${randomUUID()}-`;

describe('destination-billing gate in recordUsageMinutes (D3)', () => {
  let orgId; let userId; let agentId; let instanceId; let chargeableTrunkId; let nonChargeableTrunkId;

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

    // One of OUR public/carrier trunks (chargeable), and a non-chargeable one
    // (a customer PBX via a registration B2BUA, or a BYO carrier).
    chargeableTrunkId = `${PREFIX}public`;
    nonChargeableTrunkId = `${PREFIX}pbx`;
    await Trunk.create({ id: chargeableTrunkId, name: 'Aplisay Public', outbound: true, chargeable: true });
    await Trunk.create({ id: nonChargeableTrunkId, name: 'Customer PBX', outbound: true }); // chargeable defaults false
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
      platform: 'livekit', modelName: 'telephony:bridged-call', outboundTrunkId: chargeableTrunkId,
    });
    expect((await Call.findByPk(call.id)).outboundTrunkId).toBe(chargeableTrunkId);
  });

  it('stamps destinationRaw when the outbound trunk is chargeable (our public trunk)', async () => {
    const row = await endBridgedLeg({ outboundTrunkId: chargeableTrunkId });
    expect(row.metadata?.destinationRaw).toBe('447970123456');
  });

  it('does NOT stamp destinationRaw when the outbound trunk is not chargeable (PBX/BYO)', async () => {
    const row = await endBridgedLeg({ outboundTrunkId: nonChargeableTrunkId });
    expect(row.metadata?.destinationRaw).toBeUndefined();
  });

  it('does NOT stamp destinationRaw when there is no outbound trunk (webrtc/refer)', async () => {
    const row = await endBridgedLeg({ outboundTrunkId: null });
    expect(row.metadata?.destinationRaw).toBeUndefined();
  });

  it('does NOT stamp destinationRaw when outboundTrunkId references an unknown trunk', async () => {
    const row = await endBridgedLeg({ outboundTrunkId: `${PREFIX}ghost` });
    expect(row.metadata?.destinationRaw).toBeUndefined();
  });
});
