import { setupRealDatabase, teardownRealDatabase, Organisation, User, Agent } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// Agent.keys carries REST/MCP tool credentials; the secret fields (`value`,
// and `password` for basic auth) are encrypted at rest with CREDENTIALS_KEY,
// like the platform's other stored credentials (recording keys, SIP
// passwords). These tests pin the contract: ciphertext in the column,
// transparent decryption through the model getter (which is also what
// toJSON — the agent-db worker distribution path — serialises), an enc:
// write guard so round-tripping a loaded row never double-encrypts, and the
// idempotent startup sweep that rewrites rows written before the column was
// covered.

describe('Agent.keys at-rest encryption', () => {
  let encryptAgentKeysAtRest;
  let sequelize;

  let testOrgId;
  let testUserId;

  beforeAll(async () => {
    await setupRealDatabase();
    ({ encryptAgentKeysAtRest } = await import('../lib/database.js'));
    sequelize = Agent.sequelize;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    testOrgId = randomUUID();
    testUserId = randomUUID();
    await Organisation.create({ id: testOrgId, name: 'Test Org (keys encryption)' });
    await User.create({
      id: testUserId,
      organisationId: testOrgId,
      name: 'Test User',
      email: 'test-keys-encryption@example.com',
    });
  });

  afterEach(async () => {
    try {
      await Agent.destroy({ where: { organisationId: testOrgId } });
      if (testUserId) await User.destroy({ where: { id: testUserId } });
      if (testOrgId) await Organisation.destroy({ where: { id: testOrgId } });
    } catch {}
  });

  const makeAgent = (keys) => Agent.create({
    name: 'Keys encryption test agent',
    modelName: 'livekit:ultravox/ultravox-v0.7',
    prompt: 'You are a helpful assistant.',
    keys,
    userId: testUserId,
    organisationId: testOrgId,
  });

  const KEYS = [
    { name: 'BEARER_KEY', in: 'bearer', value: 'tok_secret_bearer' },
    { name: 'BASIC_KEY', in: 'basic', value: 'dXNlcjpwYXNz', username: 'alice', password: 'p4ssw0rd' },
    { name: 'HEADER_KEY', in: 'header', header: 'X-Api-Key', value: 'hdr_secret' },
    { name: 'NO_SECRET', in: 'header', header: 'X-Trace' },
  ];

  const isEncrypted = (v) => typeof v === 'string' && v.startsWith('enc:') && v.split(':').length === 4;

  test('secret fields are stored encrypted; the getter reads them back', async () => {
    const agent = await makeAgent(KEYS);

    const raw = agent.getDataValue('keys');
    expect(isEncrypted(raw[0].value)).toBe(true);
    expect(isEncrypted(raw[1].value)).toBe(true);
    expect(isEncrypted(raw[1].password)).toBe(true);
    expect(isEncrypted(raw[2].value)).toBe(true);
    // Non-secret fields stay readable, and an entry with no secret is untouched.
    expect(raw[1].username).toBe('alice');
    expect(raw[2].header).toBe('X-Api-Key');
    expect(raw[3]).toEqual({ name: 'NO_SECRET', in: 'header', header: 'X-Trace' });
    // Nothing secret survives in the stored JSON.
    expect(JSON.stringify(raw)).not.toContain('tok_secret_bearer');
    expect(JSON.stringify(raw)).not.toContain('p4ssw0rd');

    // The getter is the consumer surface: plaintext round-trip.
    expect(agent.keys).toEqual(KEYS);
  });

  test('a reloaded row decrypts through the getter and through toJSON', async () => {
    const { id } = await makeAgent(KEYS);
    const reloaded = await Agent.findByPk(id);
    expect(reloaded.keys).toEqual(KEYS);
    // toJSON is what the internal agent-db distribution serialises for
    // workers, so it must carry usable values.
    expect(reloaded.toJSON().keys).toEqual(KEYS);
  });

  test('round-tripping a loaded row through the setter never double-encrypts', async () => {
    const agent = await makeAgent(KEYS);

    // Getter output (plaintext) back through update: re-encrypted, still one
    // layer deep.
    await agent.update({ keys: agent.keys });
    expect(agent.keys).toEqual(KEYS);
    expect(isEncrypted(agent.getDataValue('keys')[0].value)).toBe(true);

    // Already-encrypted values back through update: the enc: guard keeps them
    // verbatim.
    const stored = agent.getDataValue('keys');
    await agent.update({ keys: stored });
    expect(agent.getDataValue('keys')[0].value).toBe(stored[0].value);
    expect(agent.getDataValue('keys')[1].password).toBe(stored[1].password);
    expect(agent.keys).toEqual(KEYS);
  });

  test('the PUT /keys merge pattern (getter output + replacements) stays encrypted and readable', async () => {
    const agent = await makeAgent(KEYS);

    // Mirror api/paths/agents/{agentId}/keys.js: existing (getter) entries the
    // caller did not mention survive, same-name entries are replaced.
    const incoming = [{ name: 'BEARER_KEY', in: 'bearer', value: 'tok_rotated' }];
    const existing = agent.keys;
    const names = new Set(incoming.map((k) => k.name));
    const merged = [...existing.filter((k) => !names.has(k.name)), ...incoming];
    await agent.update({ keys: merged });

    const raw = agent.getDataValue('keys');
    raw.filter((k) => k.value != null).forEach((k) => expect(isEncrypted(k.value)).toBe(true));
    const byName = Object.fromEntries(agent.keys.map((k) => [k.name, k]));
    expect(byName.BEARER_KEY.value).toBe('tok_rotated');
    expect(byName.BASIC_KEY.password).toBe('p4ssw0rd');
    expect(byName.HEADER_KEY.value).toBe('hdr_secret');
  });

  test('startup sweep encrypts pre-existing plaintext rows in place, idempotently', async () => {
    const agent = await makeAgent(undefined);
    const planted = [
      { name: 'LEGACY_KEY', in: 'bearer', value: 'legacy_plain_secret' },
      { name: 'LEGACY_BASIC', in: 'basic', value: 'bGVnYWN5', username: 'bob', password: 'legacy_pass' },
    ];
    // Plant plaintext under the setter's back — exactly the state of a row
    // written before this column was covered.
    await sequelize.query('UPDATE "agents" SET "keys" = $1::jsonb WHERE "id" = $2', {
      bind: [JSON.stringify(planted), agent.id],
    });
    let reloaded = await Agent.findByPk(agent.id);
    expect(reloaded.getDataValue('keys')[0].value).toBe('legacy_plain_secret');

    await encryptAgentKeysAtRest();

    reloaded = await Agent.findByPk(agent.id);
    const raw = reloaded.getDataValue('keys');
    expect(isEncrypted(raw[0].value)).toBe(true);
    expect(isEncrypted(raw[1].value)).toBe(true);
    expect(isEncrypted(raw[1].password)).toBe(true);
    expect(raw[1].username).toBe('bob');
    expect(reloaded.keys).toEqual(planted);

    // Second run: nothing left to rewrite, ciphertext byte-identical.
    await encryptAgentKeysAtRest();
    const rawAfter = (await Agent.findByPk(agent.id)).getDataValue('keys');
    expect(rawAfter).toEqual(raw);
  });

  test('startup sweep leaves mixed rows single-encrypted and skips secretless rows', async () => {
    const agent = await makeAgent([{ name: 'ALREADY', in: 'bearer', value: 'sealed_secret' }]);
    const sealed = agent.getDataValue('keys')[0].value;
    expect(isEncrypted(sealed)).toBe(true);

    // A row that is part-migrated: one sealed entry, one plaintext entry.
    const mixed = [
      { name: 'ALREADY', in: 'bearer', value: sealed },
      { name: 'STRAGGLER', in: 'header', header: 'X-Api-Key', value: 'straggler_plain' },
    ];
    await sequelize.query('UPDATE "agents" SET "keys" = $1::jsonb WHERE "id" = $2', {
      bind: [JSON.stringify(mixed), agent.id],
    });

    const secretless = await makeAgent([{ name: 'NO_SECRET', in: 'header', header: 'X-Trace' }]);
    const secretlessRawBefore = secretless.getDataValue('keys');
    const secretlessUpdatedAt = secretless.updatedAt;

    await encryptAgentKeysAtRest();

    const raw = (await Agent.findByPk(agent.id)).getDataValue('keys');
    // The sealed entry is untouched (same ciphertext — not re-wrapped)…
    expect(raw[0].value).toBe(sealed);
    // …the plaintext straggler is now sealed too, and both read back.
    expect(isEncrypted(raw[1].value)).toBe(true);
    const readable = (await Agent.findByPk(agent.id)).keys;
    expect(readable[0].value).toBe('sealed_secret');
    expect(readable[1].value).toBe('straggler_plain');

    // The secretless row was not rewritten at all.
    const secretlessAfter = await Agent.findByPk(secretless.id);
    expect(secretlessAfter.getDataValue('keys')).toEqual(secretlessRawBefore);
    expect(secretlessAfter.updatedAt.getTime()).toBe(secretlessUpdatedAt.getTime());
  });
});
