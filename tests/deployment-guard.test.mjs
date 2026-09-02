import { setupRealDatabase, teardownRealDatabase, Agent, AgentSet, Instance, PhoneNumber, PhoneRegistration, User, Organisation } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * Deployment-safety primitives behind the polite-ai "additive merge on
 * publish" design (polite-ai docs/deployment-merge-design.md):
 *
 *  - the fail-closed guard: agents holding a wired listener (a phone number
 *    or SIP registration bound through an Instance) cannot be destroyed via
 *    set reconcile, set delete or agent delete — bare WebRTC listeners never
 *    block;
 *  - PATCH /listener/{id}: repoint a listener at another same-transport agent
 *    in place (listener id and endpoint binding unchanged);
 *  - POST /agent-sets accepts an empty members array (placeholder set), while
 *    PUT still refuses one.
 */

const mockLogger = {
  info: () => { },
  warn: () => { },
  error: () => { },
  debug: () => { },
  child: () => mockLogger
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
    json(payload) { this.body = payload; return this; }
  };
}

const VOICE_MODEL = 'livekit:ultravox/ultravox-70b';

function setDocument() {
  return {
    name: 'Reception',
    description: 'Front desk pair',
    agents: [
      { label: 'front', name: 'Front desk', modelName: VOICE_MODEL, prompt: 'You answer the phone.' },
      { label: 'back', name: 'Back office', modelName: VOICE_MODEL, prompt: 'You handle follow-ups.' }
    ]
  };
}

/** Unique E.164-ish digits — parallel Jest suites share one database. */
const uniqueNumber = () => `1555${`${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9)}`;

describe('Deployment guard and listener repoint', () => {
  let user;
  let createAgentSet, getAgentSet, updateAgentSet, deleteAgentSet;
  let deleteAgent, repointListener;

  beforeAll(async () => {
    await setupRealDatabase();
    const collection = (await import('../api/paths/agent-sets.js')).default(mockLogger);
    const item = (await import('../api/paths/agent-sets/{agentSetId}.js')).default(mockLogger);
    const agentItem = (await import('../api/paths/agents/{agentId}.js')).default(mockLogger, {}, {});
    const listenerItem = (await import('../api/paths/listener/{listenerId}.js')).default(mockLogger);
    createAgentSet = collection.POST;
    getAgentSet = item.GET;
    updateAgentSet = item.PUT;
    deleteAgentSet = item.DELETE;
    deleteAgent = agentItem.DELETE;
    repointListener = listenerItem.PATCH;
  }, 60000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    const org = await Organisation.create({ id: randomUUID(), name: 'Deployment Guard Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'Guard Tester',
      email: `guard-${Date.now()}@test.example.com`,
      emailVerified: true,
      phone: '+15550000000',
      phoneVerified: false,
      picture: '',
      role: 'owner',
      organisationId: org.id
    });
    user = { id: dbUser.id, organisationId: org.id, role: 'owner' };
  });

  /** Create a set through the API and return { set, byLabel }. */
  async function makeSet(doc = setDocument()) {
    const res = makeRes(user);
    await createAgentSet(makeReq(doc), res);
    expect(res.statusCode).toBe(200);
    const byLabel = Object.fromEntries(res.body.agents.map((a) => [a.label, a]));
    return { set: res.body, byLabel };
  }

  /** Bind a listener (Instance) to an agent, optionally with a number/registration. */
  async function wire(agentId, { number = false, registration = false } = {}) {
    const instance = await Instance.create({
      agentId,
      userId: user.id,
      organisationId: user.organisationId,
      type: 'livekit',
      key: `test-${randomUUID()}`
    });
    let phoneNumber = null, phoneRegistration = null;
    if (number) {
      phoneNumber = await PhoneNumber.create({
        number: uniqueNumber(),
        handler: 'livekit',
        organisationId: user.organisationId,
        instanceId: instance.id
      });
    }
    if (registration) {
      phoneRegistration = await PhoneRegistration.create({
        name: 'Test PBX',
        handler: 'livekit',
        registrar: 'sip.example.com',
        username: `user-${Date.now()}`,
        password: 'secret',
        organisationId: user.organisationId,
        instanceId: instance.id
      });
    }
    return { instance, phoneNumber, phoneRegistration };
  }

  test('PUT refuses to reconcile away a member wired to a phone number', async () => {
    const { set, byLabel } = await makeSet();
    const { instance, phoneNumber } = await wire(byLabel.back.id, { number: true });

    const doc = setDocument();
    doc.agents = doc.agents.filter((a) => a.label !== 'back');
    const res = makeRes(user);
    await updateAgentSet(makeReq(doc, { agentSetId: set.id }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/In use/);
    expect(res.body.message).toMatch(/back/);
    // Transactional: the member, listener and number binding all survive.
    expect(await Agent.findByPk(byLabel.back.id)).not.toBeNull();
    expect(await Instance.findByPk(instance.id)).not.toBeNull();
    expect((await PhoneNumber.findOne({ where: { number: phoneNumber.number } })).instanceId).toBe(instance.id);
  });

  test('PUT still reconciles away an unwired member, and one holding only a bare WebRTC listener', async () => {
    const { set, byLabel } = await makeSet();
    // Bare instance (WebRTC test session): no number, no registration.
    await wire(byLabel.back.id);

    const doc = setDocument();
    doc.agents = doc.agents.filter((a) => a.label !== 'back');
    const res = makeRes(user);
    await updateAgentSet(makeReq(doc, { agentSetId: set.id }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.agents.map((a) => a.label)).toEqual(['front']);
    expect(await Agent.findByPk(byLabel.back.id)).toBeNull();
  });

  test('DELETE /agent-sets/{id} refuses while a member is wired, succeeds after undeploy', async () => {
    const { set, byLabel } = await makeSet();
    const { instance } = await wire(byLabel.front.id, { registration: true });

    const blocked = makeRes(user);
    await deleteAgentSet(makeReq({}, { agentSetId: set.id }), blocked);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.message).toMatch(/registration/);
    expect(await AgentSet.findByPk(set.id)).not.toBeNull();

    await instance.destroy();
    const ok = makeRes(user);
    await deleteAgentSet(makeReq({}, { agentSetId: set.id }), ok);
    expect(ok.statusCode).toBe(200);
    expect(await AgentSet.findByPk(set.id)).toBeNull();
  });

  test('DELETE /agents/{id} refuses while wired, succeeds after undeploy', async () => {
    const { byLabel } = await makeSet();
    const { instance, phoneNumber } = await wire(byLabel.front.id, { number: true });

    const blocked = makeRes(user);
    await deleteAgent(makeReq({}, { agentId: byLabel.front.id }), blocked);
    expect(blocked.statusCode).toBe(409);
    expect(await Agent.findByPk(byLabel.front.id)).not.toBeNull();

    await instance.destroy();
    // Number detached (SET NULL), not deleted, when the listener goes.
    expect((await PhoneNumber.findOne({ where: { number: phoneNumber.number } })).instanceId).toBeNull();
    const ok = makeRes(user);
    await deleteAgent(makeReq({}, { agentId: byLabel.front.id }), ok);
    expect(ok.statusCode).toBe(200);
  });

  test('PATCH /listener/{id} repoints in place: same id, number binding untouched', async () => {
    const { byLabel } = await makeSet();
    const { instance, phoneNumber } = await wire(byLabel.front.id, { number: true });

    const res = makeRes(user);
    await repointListener(makeReq({ agentId: byLabel.back.id }, { listenerId: instance.id }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: instance.id, agentId: byLabel.back.id });
    const after = await Instance.findByPk(instance.id);
    expect(after.agentId).toBe(byLabel.back.id);
    expect((await PhoneNumber.findOne({ where: { number: phoneNumber.number } })).instanceId).toBe(instance.id);

    // The old agent is now unwired and can be reconciled away.
    const doc = setDocument();
    doc.agents = doc.agents.filter((a) => a.label !== 'front');
    const setRes = makeRes(user);
    const sets = await AgentSet.findAll({ where: { organisationId: user.organisationId } });
    await updateAgentSet(makeReq(doc, { agentSetId: sets[0].id }), setRes);
    expect(setRes.statusCode).toBe(200);
  });

  test('PATCH /listener/{id} rejects a transport-mismatched or foreign target', async () => {
    const { byLabel } = await makeSet();
    const { instance } = await wire(byLabel.front.id, { number: true });

    // Text agents have no telephony transport → 412.
    const textRes = makeRes(user);
    const doc = setDocument();
    doc.agents.push({ label: 'texty', name: 'Text agent', modelName: 'text:openai/gpt-4o', type: 'text', prompt: 'You write.' });
    const created = makeRes(user);
    await createAgentSet(makeReq(doc), created);
    const texty = created.body.agents.find((a) => a.label === 'texty');
    await repointListener(makeReq({ agentId: texty.id }, { listenerId: instance.id }), textRes);
    expect(textRes.statusCode).toBe(412);

    // An agent outside the caller's organisation → 404, listener unchanged.
    const otherOrg = await Organisation.create({ id: randomUUID(), name: 'Other Org' });
    const otherUser = await User.create({
      id: randomUUID(), name: 'Other', email: `other-${Date.now()}@test.example.com`,
      emailVerified: true, phone: '+15550000001', phoneVerified: false, picture: '',
      role: 'owner', organisationId: otherOrg.id
    });
    const foreign = await Agent.create({
      userId: otherUser.id, organisationId: otherOrg.id,
      name: 'Foreign', modelName: VOICE_MODEL, prompt: 'x'
    });
    const foreignRes = makeRes(user);
    await repointListener(makeReq({ agentId: foreign.id }, { listenerId: instance.id }), foreignRes);
    expect(foreignRes.statusCode).toBe(404);
    expect((await Instance.findByPk(instance.id)).agentId).toBe(byLabel.front.id);
  });

  test('POST /agent-sets accepts an empty members array; PUT still refuses one', async () => {
    const res = makeRes(user);
    await createAgentSet(makeReq({ name: 'Untitled team', agents: [] }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.agents).toEqual([]);
    expect(res.body.name).toBe('Untitled team');

    // The placeholder fills in through the ordinary update path…
    const fill = makeRes(user);
    await updateAgentSet(makeReq(setDocument(), { agentSetId: res.body.id }), fill);
    expect(fill.statusCode).toBe(200);
    expect(fill.body.agents).toHaveLength(2);

    // …but a PUT can never empty a team (truncation safety).
    const wipe = makeRes(user);
    await updateAgentSet(makeReq({ name: 'X', agents: [] }, { agentSetId: res.body.id }), wipe);
    expect(wipe.statusCode).toBe(400);
    expect(wipe.body.message).toMatch(/non-empty/);
  });
});
