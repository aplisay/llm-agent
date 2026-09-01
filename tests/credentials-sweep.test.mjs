// Credentials-at-rest audit + sweep (lib/utils/credentials-sweep.js).
//
// Legacy databases created while CREDENTIALS_KEY was empty hold raw plaintext
// credentials. These tests simulate that state by creating rows through the
// models (which encrypt, since the test wrapper sets a key) and then raw-SQL
// updating the stored values back to plaintext — then verify the audit
// classifies them and the boot sweep encrypts them in place without changing
// what the models read. All row-level assertions are scoped to the ids seeded
// here, so suites sharing the test database cannot interfere.
import {
  setupRealDatabase, teardownRealDatabase,
  Organisation, User, Agent, Instance, Call, PhoneRegistration, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID, createHash, createCipheriv, randomBytes } from 'crypto';
import { auditStoredCredentials, sweepPlaintextCredentials } from '../lib/utils/credentials-sweep.js';
import { encryptSecret, decryptSecret, classifyStoredSecret, isEncryptedSecretFormat } from '../lib/utils/credentials.js';

// A structurally valid blob encrypted under a DIFFERENT key: what an audit
// should call encrypted-foreign and a sweep must never touch.
const foreignBlob = (plain) => {
  const key = createHash('sha256').update('some-other-credentials-key').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
};

const LOOKALIKE = 'enc:not-a-real-blob';

describe('classifyStoredSecret', () => {
  test('classifies plaintext, round-trip encrypted, lookalike, and foreign values', () => {
    expect(classifyStoredSecret(null)).toBe('empty');
    expect(classifyStoredSecret(42)).toBe('non-string');
    expect(classifyStoredSecret('hunter2')).toBe('plaintext');
    expect(classifyStoredSecret(LOOKALIKE)).toBe('enc-lookalike');
    expect(classifyStoredSecret('enc:AAAA:BBBB:CCCC')).toBe('enc-lookalike');

    const blob = encryptSecret('hunter2');
    expect(isEncryptedSecretFormat(blob)).toBe(true);
    expect(classifyStoredSecret(blob)).toBe('encrypted');
    expect(decryptSecret(blob)).toBe('hunter2');

    expect(classifyStoredSecret(foreignBlob('hunter2'))).toBe('encrypted-foreign');
  });

  test('a plaintext credential that happens to start with enc: is not misread as encrypted', () => {
    expect(classifyStoredSecret('enc:ode-my-password')).toBe('enc-lookalike');
  });
});

describe('credentials-at-rest audit and sweep', () => {
  let sequelize;
  let orgId, userId, agentId, instanceId, callId;
  let regPlainId, regLookalikeId, regForeignId;
  const AGENT_SECRET = 'agent-recording-secret';
  const INSTANCE_SECRET = 'instance-recording-secret';
  const CALL_SECRET = 'call-encryption-secret';
  const REG_SECRET = 'registration-password-secret';

  const storedValue = async (sql, id) => {
    const [rows] = await sequelize.query(sql, { replacements: { id } });
    return rows[0]?.value;
  };
  const storedPassword = (id) =>
    storedValue('SELECT "password" AS value FROM "phone_registrations" WHERE "id" = :id', id);

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    sequelize = Agent.sequelize;

    orgId = randomUUID();
    userId = randomUUID();
    agentId = randomUUID();
    instanceId = randomUUID();

    await Organisation.create({ id: orgId, name: 'Sweep Org' });
    await User.create({
      id: userId, name: 'Sweep User', email: `sweep-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgId,
    });
    // validate:false skips the heavy handler/voice validation (irrelevant here).
    await Agent.create(
      {
        id: agentId, name: 'Sweep Agent', modelName: 'livekit:test-model', userId, organisationId: orgId,
        options: { temperature: 0.5, recording: { key: AGENT_SECRET, url: 'gs://bucket/prefix' } },
      },
      { validate: false },
    );
    await Instance.create({
      id: instanceId, agentId, type: 'livekit', userId, organisationId: orgId,
      recording: { key: INSTANCE_SECRET, mode: 'full' },
    });
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId,
      calledId: '441234567890', callerId: '447700900000',
      platform: 'livekit', modelName: 'livekit:test-model',
    });
    callId = call.id;

    const makeReg = (name) => PhoneRegistration.create({
      name, registrar: 'sip:provider.example.com:5060', username: `u-${randomUUID().slice(0, 8)}`,
      password: 'to-be-replaced', handler: 'livekit', organisationId: orgId,
    });
    regPlainId = (await makeReg('Sweep plaintext')).id;
    regLookalikeId = (await makeReg('Sweep lookalike')).id;
    regForeignId = (await makeReg('Sweep foreign')).id;

    // Simulate the legacy (empty-CREDENTIALS_KEY) database: plant raw stored
    // values underneath the models, bypassing the encrypting setters.
    await sequelize.query(
      `UPDATE "agents" SET "options" = jsonb_set("options", '{recording,key}', to_jsonb(CAST(:v AS text))) WHERE "id" = :id`,
      { replacements: { v: AGENT_SECRET, id: agentId } });
    await sequelize.query(
      `UPDATE "instances" SET "recording" = jsonb_set("recording", '{key}', to_jsonb(CAST(:v AS text))) WHERE "id" = :id`,
      { replacements: { v: INSTANCE_SECRET, id: instanceId } });
    await sequelize.query(
      `UPDATE "calls" SET "encryption_key" = :v WHERE "id" = :id`,
      { replacements: { v: CALL_SECRET, id: callId } });
    await sequelize.query(
      `UPDATE "phone_registrations" SET "password" = :v WHERE "id" = :id`,
      { replacements: { v: REG_SECRET, id: regPlainId } });
    await sequelize.query(
      `UPDATE "phone_registrations" SET "password" = :v WHERE "id" = :id`,
      { replacements: { v: LOOKALIKE, id: regLookalikeId } });
    await sequelize.query(
      `UPDATE "phone_registrations" SET "password" = :v WHERE "id" = :id`,
      { replacements: { v: foreignBlob(REG_SECRET), id: regForeignId } });
  }, 30000);

  afterAll(async () => {
    await PhoneRegistration.destroy({ where: { organisationId: orgId } });
    await Organisation.destroy({ where: { id: orgId } }); // cascades user/agent/instance/call
    await teardownRealDatabase();
  }, 60000);

  test('audit classifies the legacy rows and surfaces anomalies by id, never by value', async () => {
    const report = await auditStoredCredentials(sequelize);
    expect(report.hasCredentialsKey).toBe(true);
    const byLabel = Object.fromEntries(report.locations.map((l) => [l.label, l]));

    for (const label of [
      'phone_registrations.password', 'calls.encryption_key',
      'agents.options.recording.key', 'instances.recording.key',
    ]) {
      expect(byLabel[label]).toBeDefined();
      expect(byLabel[label].error).toBeNull();
      expect(byLabel[label].counts.plaintext).toBeGreaterThanOrEqual(1);
    }
    const regs = byLabel['phone_registrations.password'];
    expect(regs.anomalies['enc-lookalike']).toContain(regLookalikeId);
    expect(regs.anomalies['encrypted-foreign']).toContain(regForeignId);
    expect(JSON.stringify(report)).not.toContain(REG_SECRET);
  });

  test('sweep encrypts exactly the plaintext rows, leaving lookalike and foreign values untouched', async () => {
    const summary = await sweepPlaintextCredentials(sequelize);
    expect(summary.swept).toBe(true);
    for (const loc of summary.locations) {
      expect(loc.error).toBeNull();
      expect(loc.updated).toBeGreaterThanOrEqual(1);
    }

    const agentStored = await storedValue(
      `SELECT "options"#>>'{recording,key}' AS value FROM "agents" WHERE "id" = :id`, agentId);
    const instanceStored = await storedValue(
      `SELECT "recording"#>>'{key}' AS value FROM "instances" WHERE "id" = :id`, instanceId);
    const callStored = await storedValue(
      `SELECT "encryption_key" AS value FROM "calls" WHERE "id" = :id`, callId);
    const regStored = await storedPassword(regPlainId);

    for (const stored of [agentStored, instanceStored, callStored, regStored]) {
      expect(classifyStoredSecret(stored)).toBe('encrypted');
    }
    expect(await storedPassword(regLookalikeId)).toBe(LOOKALIKE);
    expect(classifyStoredSecret(await storedPassword(regForeignId))).toBe('encrypted-foreign');
  });

  test('models read the swept values back decrypted, with JSONB siblings intact', async () => {
    const agent = await Agent.findByPk(agentId);
    expect(agent.options.recording.key).toBe(AGENT_SECRET);
    expect(agent.options.recording.url).toBe('gs://bucket/prefix');
    expect(agent.options.temperature).toBe(0.5);

    const instance = await Instance.findByPk(instanceId);
    expect(instance.recording.key).toBe(INSTANCE_SECRET);
    expect(instance.recording.mode).toBe('full');

    const call = await Call.findByPk(callId);
    expect(call.encryptionKey).toBe(CALL_SECRET);

    const reg = await PhoneRegistration.findByPk(regPlainId);
    expect(reg.password).toBe(REG_SECRET);
  });

  test('sweep is idempotent: a second run finds nothing and rewrites nothing', async () => {
    // Converge first (a no-op when the earlier test already swept), so this
    // test also stands alone under jest -t.
    await sweepPlaintextCredentials(sequelize);
    const before = await storedPassword(regPlainId);
    const summary = await sweepPlaintextCredentials(sequelize);
    for (const loc of summary.locations) {
      expect(loc.error).toBeNull();
      expect(loc.candidates).toBe(0);
      expect(loc.updated).toBe(0);
    }
    // Same blob byte-for-byte: an idempotent pass must not re-encrypt (new IV).
    expect(await storedPassword(regPlainId)).toBe(before);
  });
});
