import {
  setupRealDatabase, teardownRealDatabase,
  Agent, TransactionLog, User, Organisation,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { validateAuxSttShape } from '../lib/database.js';

/**
 * options.stt.aux — the auxiliary ("second opinion") STT: shape validation at
 * agent save time, handler gating, round-trip of the stored block, the new
 * `user-aux` transaction-log type, and the pure validator's error texts.
 * See docs/auxiliary-stt.md.
 */

const mockLogger = {
  info: () => { }, warn: () => { }, error: () => { }, debug: () => { }, child: () => mockLogger,
};

function makeReq(body = {}, params = {}, query = {}) {
  return { body, params, query, log: mockLogger };
}

function makeRes(user) {
  return {
    locals: { user },
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const LIVEKIT_MODEL = 'livekit:ultravox/ultravox-70b';
const PIPECAT_MODEL = 'pipecat:openai/gpt-4o';
const TEXT_MODEL = 'text:openai/gpt-4o';

describe('options.stt.aux (auxiliary STT)', () => {
  let createAgent, getAgent;
  let user, org;

  beforeAll(async () => {
    await setupRealDatabase();
    const agents = (await import('../api/paths/agents.js')).default(mockLogger, {}, {});
    createAgent = agents.POST;
    const item = (await import('../api/paths/agents/{agentId}.js')).default(mockLogger, {}, {});
    getAgent = item.GET;

    org = await Organisation.create({ id: randomUUID(), name: 'Aux STT Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'Aux STT Tester',
      email: `aux-stt-${randomUUID()}@example.com`,
      emailVerified: true,
      phone: '',
      phoneVerified: false,
      picture: '',
      role: 'owner',
      organisationId: org.id,
    });
    user = { id: dbUser.id, organisationId: org.id, role: 'owner' };
  }, 60000);

  afterAll(async () => {
    await Agent.destroy({ where: { organisationId: org.id } });
    await User.destroy({ where: { organisationId: org.id } });
    await Organisation.destroy({ where: { id: org.id } });
    await teardownRealDatabase();
  }, 60000);

  const create = async (body) => {
    const res = makeRes(user);
    await createAgent(makeReq(body), res);
    return res;
  };

  test('accepts the documented shapes on LiveKit and Pipecat models', async () => {
    for (const [modelName, aux] of [
      [LIVEKIT_MODEL, {}],
      [LIVEKIT_MODEL, { vendor: 'assemblyai', language: 'en-GB' }],
      [LIVEKIT_MODEL, { vendor: 'deepgram/nova-2:en' }],
      [LIVEKIT_MODEL, { enabled: false }],
      [LIVEKIT_MODEL, { language: 'any' }], // "no fixed language" sentinel, as options.stt allows
      [PIPECAT_MODEL, { vendor: 'google', language: 'fr-FR' }],
    ]) {
      const res = await create({ modelName, prompt: 'front desk', options: { stt: { aux } } });
      expect([res.statusCode, JSON.stringify(res.body)]).toEqual([200, expect.any(String)]);
    }
  });

  test('round-trips the stored block next to the primary stt options', async () => {
    const options = {
      stt: { vendor: 'deepgram', language: 'en-US', aux: { vendor: 'assemblyai', language: 'en-GB' } },
    };
    const res = await create({ modelName: LIVEKIT_MODEL, prompt: 'front desk', options });
    expect(res.statusCode).toBe(200);
    const got = makeRes(user);
    await getAgent(makeReq({}, { agentId: res.body.id }), got);
    expect(got.statusCode).toBe(200);
    expect(got.body.options.stt).toEqual(options.stt);
  });

  test('rejects malformed shapes with a 400 that names the problem', async () => {
    for (const [aux, pattern] of [
      [true, /same shape as options\.stt/],
      ['assemblyai', /same shape as options\.stt/],
      [['assemblyai'], /same shape as options\.stt/],
      [{ provider: 'assemblyai' }, /unknown field/],
      [{ aux: {} }, /unknown field/], // never nested
      [{ enabled: 'yes' }, /enabled must be a boolean/],
      [{ vendor: 'bad vendor!' }, /vendor must be an STT vendor name/],
      [{ vendor: 42 }, /vendor must be an STT vendor name/],
      [{ language: 'English!' }, /BCP-47/],
    ]) {
      const res = await create({ modelName: LIVEKIT_MODEL, prompt: 'front desk', options: { stt: { aux } } });
      expect([res.statusCode, JSON.stringify(res.body)]).toEqual([400, expect.stringMatching(pattern)]);
    }
  });

  test('rejects the option on a model whose handler cannot tap the caller audio', async () => {
    const res = await create({
      modelName: TEXT_MODEL, type: 'text', prompt: 'writer', options: { stt: { aux: {} } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/does not support auxiliary STT/);
  });

  test('transaction_logs.type carries user-aux, in the model and in the live enum (schema v64)', async () => {
    expect(TransactionLog.rawAttributes.type.values).toContain('user-aux');
    // The forced sync the test wrapper runs must have added the value to the
    // Postgres enum itself — that is what a DB_FORCE_SYNC deploy relies on.
    const [labels] = await TransactionLog.sequelize.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'enum_transaction_logs_type' ORDER BY e.enumsortorder`,
    );
    expect(labels.map((l) => l.enumlabel)).toEqual(expect.arrayContaining(['user', 'user-aux', 'agent']));
  });

  test('validateAuxSttShape: pure validator contract', () => {
    const ok = (aux) => expect(() => validateAuxSttShape(aux, { hasAuxStt: true, modelName: 'm' })).not.toThrow();
    const bad = (aux, pattern, flags = { hasAuxStt: true, modelName: 'm' }) => {
      let err;
      try { validateAuxSttShape(aux, flags); } catch (e) { err = e; }
      expect(err).toBeTruthy();
      expect(err.status).toBe(400);
      expect(err.message).toMatch(pattern);
    };
    ok({});
    ok({ vendor: 'deepgram', language: 'en', enabled: true });
    ok({ vendor: 'deepgram/nova-3:en' });
    ok({ language: 'multi' });
    bad(null, /must be an object/);
    bad({}, /Model m does not support auxiliary STT/, { hasAuxStt: false, modelName: 'm' });
    bad({ bogus: 1 }, /unknown field\(s\) bogus/);
    bad({ language: 'en_GB' }, /BCP-47/);
    // The context label is threaded into every message (listener-override reuse).
    bad({ bogus: 1 }, /^listener\.stt\.aux has unknown/, { hasAuxStt: true, modelName: 'm', context: 'listener.stt.aux' });
  });
});
