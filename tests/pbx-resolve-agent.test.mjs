/**
 * A call that belongs to an agent: the resolve route names the agent, for a
 * number and for a registration. Through the real routes and the test
 * database, beside the lookup the agent workers use, so the two can be
 * compared.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import {
  setupRealDatabase,
  teardownRealDatabase,
  Organisation,
  User,
  Agent,
  Instance,
  PhoneNumber,
  PhoneRegistration,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const tag = randomUUID().slice(0, 8);
const TRUNK_A = `resolve-agent-a-${tag}`;
const TRUNK_B = `resolve-agent-b-${tag}`;
const TRUNK_REG = `resolve-agent-reg-${tag}`;

describe('the resolve route names the agent of a call', () => {
  let server;
  let db;
  let savedEnv;
  const orgs = {};
  const instances = {};
  const registrations = {};
  let extension;
  const stamp = String(Date.now()).slice(-6);
  const ddi = (n) => `4420795${stamp.slice(0, 2)}${String(n).padStart(3, '0')}`;

  const resolve = async (body) => {
    const res = await request(server).post('/api/agent-db/pbx/resolve').send({ callId: 'c-1', request: body });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  // What a worker asks today for the same call.
  const workerLookup = (query) => request(server).get('/api/agent-db/phone-endpoints').query(query);

  async function newOrg(name, capabilities = []) {
    const id = randomUUID();
    await Organisation.create({ id, name, capabilities });
    return id;
  }

  async function newInstance(organisationId, type, { withAgent = true } = {}) {
    const userId = randomUUID();
    await User.create({
      id: userId, organisationId, name: 'Agent owner', email: `resolve-agent-${userId}@test.example.com`, emailVerified: true,
      phone: '+10000000000', phoneVerified: true, picture: 'https://example.com/p.png', role: 'owner',
    });
    const agent = withAgent
      ? await Agent.create({
        name: 'Front desk agent', description: 't', modelName: 'livekit:ultravox/ultravox-v0.7', prompt: 'You are a test agent.',
        options: {}, functions: {}, keys: [], userId, organisationId,
      })
      : null;
    return Instance.create({ agentId: agent?.id ?? null, type, key: 'k', userId, organisationId });
  }

  const newRegistration = (organisationId, extra = {}) => PhoneRegistration.create({
    name: 'Test connection', registrar: 'sip:pbx.test.example.com:5060', username: `u${randomUUID().slice(0, 8)}`, password: 'p',
    handler: 'pipecat', organisationId, status: 'active', state: 'registered', ...extra,
  });

  beforeAll(async () => {
    savedEnv = { ...process.env };
    delete process.env.PBX_RELEASE;
    await setupRealDatabase();
    db = await import('../lib/database.js');

    // `plain` and `other` have no phone system. `pbx` has one.
    orgs.plain = await newOrg('Resolve agent test, plain');
    orgs.other = await newOrg('Resolve agent test, other');
    orgs.pbx = await newOrg('Resolve agent test, phone system', ['phoneSystem']);
    for (const id of [TRUNK_A, TRUNK_B, TRUNK_REG]) await db.Trunk.create({ id, name: id, handler: 'pipecat' });

    instances.pipecat = await newInstance(orgs.plain, 'pipecat');
    instances.otherPipecat = await newInstance(orgs.other, 'pipecat');
    instances.livekit = await newInstance(orgs.plain, 'livekit');
    instances.noAgent = await newInstance(orgs.plain, 'pipecat', { withAgent: false });

    const number = (n, organisationId, aplisayId, extra = {}) => PhoneNumber.create({
      number: ddi(n), handler: 'pipecat', organisationId, aplisayId, ...extra,
    });
    // One number on two trunks, with a different agent on each.
    await number(1, orgs.plain, TRUNK_A, { instanceId: instances.pipecat.id });
    await number(1, orgs.other, TRUNK_B, { instanceId: instances.otherPipecat.id });
    await number(2, orgs.plain, TRUNK_A, { instanceId: instances.livekit.id });
    await number(3, orgs.plain, TRUNK_A, { instanceId: instances.noAgent.id });
    await number(4, orgs.plain, TRUNK_A);
    await number(6, orgs.plain, TRUNK_REG, { instanceId: instances.pipecat.id });
    await number(7, orgs.plain, TRUNK_REG);

    const entry = await db.DirectoryEntry.create({ organisationId: orgs.pbx, kind: 'team', name: 'Sales' });
    extension = await db.Extension.create({ organisationId: orgs.pbx, entryId: entry.id, number: '200', type: 'ring_all' });
    await number(5, orgs.pbx, TRUNK_A, { handler: 'pbx', extensionId: extension.id });

    registrations.withAgent = await newRegistration(orgs.plain, { instanceId: instances.pipecat.id });
    registrations.livekit = await newRegistration(orgs.plain, { instanceId: instances.livekit.id });
    registrations.idle = await newRegistration(orgs.plain);
    registrations.trunk = await newRegistration(orgs.plain, { trunkId: TRUNK_REG });
    registrations.staleTrunk = await newRegistration(orgs.plain, { trunkId: TRUNK_REG, instanceId: instances.noAgent.id });
    registrations.deskLine = await newRegistration(orgs.plain, { mode: 'registrar', kind: 'device', instanceId: instances.pipecat.id });

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.log = log;
      next();
    });
    // express-openapi imports every route file at once, which jest's module
    // loader cannot do for files that share imports. Load them one by one first.
    for (const file of ['agent-db/pbx/resolve.js', 'agent-db/phone-endpoints.js']) await import(`../api/paths/${file}`);
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: 'agent-db/{pbx/resolve,phone-endpoints}.js',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    // 127.0.0.1 and one server: see tests/pbx-directory-api.test.mjs.
    server = app.listen(0, '127.0.0.1');
    await new Promise((done) => server.once('listening', done));
  }, 60000);

  afterAll(async () => {
    await new Promise((done) => server.close(done));
    const ids = Object.values(orgs);
    const where = { organisationId: ids };
    await PhoneNumber.destroy({ where });
    await PhoneRegistration.destroy({ where });
    await db.Extension.destroy({ where });
    await db.DirectoryEntry.destroy({ where });
    await Instance.destroy({ where });
    await Agent.destroy({ where });
    await User.destroy({ where });
    await db.Trunk.destroy({ where: { id: [TRUNK_A, TRUNK_B, TRUNK_REG] } });
    await Organisation.destroy({ where: { id: ids } });
    process.env = savedEnv;
    await teardownRealDatabase();
  }, 60000);

  const agentOf = (instance) => ({ instanceId: instance.id, agentId: instance.agentId, runtime: instance.type });

  describe('a call to a number', () => {
    test("an agent's number gives the agent, for an organisation with no phone system", async () => {
      const plan = await resolve({ kind: 'number', calledNumber: `+${ddi(1)}`, trunkId: TRUNK_A, callerId: '+447700900123' });
      expect(plan).toMatchObject({ callId: 'c-1', action: 'agent', organisationId: orgs.plain, ttlSeconds: 5, agent: agentOf(instances.pipecat) });
      expect(plan.planId).toMatch(/^p-/);
      expect((await Organisation.findByPk(orgs.plain)).capabilities).toEqual([]);
    });

    test('a number routed to an extension keeps the plan of the extension', async () => {
      const plan = await resolve({ kind: 'number', calledNumber: ddi(5), trunkId: TRUNK_A, callerId: '+447700900123' });
      expect(plan).toMatchObject({ action: 'ring', organisationId: orgs.pbx, target: { extensionId: extension.id, number: '200' } });
      expect(plan.agent).toBeUndefined();
    });

    test('an instance on another runtime, or with no agent, is refused with its reason', async () => {
      // No organisation on these: call control would record them as phone system calls.
      expect(await resolve({ kind: 'number', calledNumber: ddi(2), trunkId: TRUNK_A }))
        .toMatchObject({ action: 'refuse', reason: 'runtime_not_supported', organisationId: null });
      expect(await resolve({ kind: 'number', calledNumber: ddi(3), trunkId: TRUNK_A }))
        .toMatchObject({ action: 'refuse', reason: 'agent_not_available', organisationId: null });
    });

    test('a number that nothing listens on, or that is not on the trunk, is still refused', async () => {
      expect(await resolve({ kind: 'number', calledNumber: ddi(4), trunkId: TRUNK_A }))
        .toMatchObject({ action: 'refuse', reason: 'number_not_routed', organisationId: orgs.plain });
      expect(await resolve({ kind: 'number', calledNumber: ddi(2), trunkId: TRUNK_B })).toMatchObject({ action: 'refuse', reason: 'number_not_found' });
      expect(await resolve({ kind: 'number', calledNumber: '+442079469999', trunkId: TRUNK_A })).toMatchObject({ action: 'refuse', reason: 'number_not_found' });
    });

    test('a number on two trunks gives the agent a worker finds for each trunk', async () => {
      const cases = [
        [TRUNK_A, instances.pipecat, orgs.plain],
        [TRUNK_B, instances.otherPipecat, orgs.other],
        // The SBC can name several candidate trunks.
        [`nothing-here;${TRUNK_B}`, instances.otherPipecat, orgs.other],
      ];
      for (const [trunkId, instance, organisationId] of cases) {
        const plan = await resolve({ kind: 'number', calledNumber: ddi(1), trunkId });
        const worker = await workerLookup({ number: `+${ddi(1)}`, trunkId });
        expect(worker.status).toBe(200);
        expect(plan).toMatchObject({ action: 'agent', organisationId, agent: agentOf(instance) });
        expect(worker.body.items[0].instanceId).toBe(plan.agent.instanceId);
      }
      // Where a worker is told "trunk mismatch", the plan is a refusal.
      expect((await workerLookup({ number: ddi(2), trunkId: TRUNK_B })).status).toBe(400);
    });
  });

  describe('a call from a registration', () => {
    const fromRegistration = (registration, calledNumber) => resolve({
      kind: 'registration', registrationId: registration.id ?? registration, calledNumber, callerId: '201',
    });

    test('a registration an agent listens on gives that agent, as a worker finds it', async () => {
      const plan = await fromRegistration(registrations.withAgent, '8092');
      expect(plan).toMatchObject({ action: 'agent', organisationId: orgs.plain, agent: agentOf(instances.pipecat) });
      const worker = await workerLookup({ id: registrations.withAgent.id });
      expect(worker.body.items[0].instanceId).toBe(plan.agent.instanceId);
    });

    test('a registration that is a trunk gives the agent of the number called on it', async () => {
      expect(await fromRegistration(registrations.trunk, `+${ddi(6)}`))
        .toMatchObject({ action: 'agent', organisationId: orgs.plain, agent: agentOf(instances.pipecat) });
      // Its own agent is tried first. When that one is gone the number decides, as in a worker.
      expect(await fromRegistration(registrations.staleTrunk, ddi(6))).toMatchObject({ action: 'agent', agent: agentOf(instances.pipecat) });
      expect(await fromRegistration(registrations.staleTrunk, ddi(7))).toMatchObject({ action: 'refuse', reason: 'agent_not_available' });
      // A number is looked up on the registration's own trunk, never without one.
      expect(await fromRegistration(registrations.trunk, ddi(7))).toMatchObject({ action: 'refuse', reason: 'registration_not_routed' });
      expect(await fromRegistration(registrations.trunk, ddi(1))).toMatchObject({ action: 'refuse', reason: 'registration_not_routed' });
      expect(await fromRegistration(registrations.idle, ddi(1))).toMatchObject({ action: 'refuse', reason: 'registration_not_routed' });
    });

    test('a registration of a deactivated organisation is refused', async () => {
      await Organisation.update({ status: 'deactivated' }, { where: { id: orgs.plain } });
      try {
        expect(await fromRegistration(registrations.withAgent, '8092'))
          .toMatchObject({ action: 'refuse', reason: 'organisation_deactivated', organisationId: null });
        expect(await fromRegistration(registrations.trunk, `+${ddi(6)}`)).toMatchObject({ action: 'refuse', reason: 'organisation_deactivated' });
        // A call to a number an agent listens on is not a call from a registration.
        expect(await resolve({ kind: 'number', calledNumber: `+${ddi(1)}`, trunkId: TRUNK_A })).toMatchObject({ action: 'agent' });
        await Organisation.update({ status: 'suspended' }, { where: { id: orgs.plain } });
        expect(await fromRegistration(registrations.withAgent, '8092')).toMatchObject({ action: 'agent' });
      } finally {
        await Organisation.update({ status: 'active' }, { where: { id: orgs.plain } });
      }
    });

    test('the refusals', async () => {
      expect(await fromRegistration(registrations.idle, '8092'))
        .toMatchObject({ action: 'refuse', reason: 'registration_not_routed', organisationId: null });
      expect(await fromRegistration(registrations.livekit, '8092'))
        .toMatchObject({ action: 'refuse', reason: 'runtime_not_supported', organisationId: null });
      expect(await fromRegistration(randomUUID(), '8092')).toMatchObject({ action: 'refuse', reason: 'registration_not_found', organisationId: null });
      expect(await fromRegistration('not-an-id', '8092')).toMatchObject({ action: 'refuse', reason: 'registration_not_found' });
      // The SIP account of a desk phone line is not a registration connection.
      expect(await fromRegistration(registrations.deskLine, '8092')).toMatchObject({ action: 'refuse', reason: 'registration_not_found' });
      expect((await workerLookup({ id: registrations.deskLine.id })).status).toBe(404);
      const bad = await request(server).post('/api/agent-db/pbx/resolve').send({ request: { kind: 'registration', calledNumber: '8092' } });
      expect(bad.status).toBe(400);
    });
  });
});
