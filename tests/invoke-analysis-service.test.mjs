// POST /agents/{agentId}/invoke on behalf of an organisation, and per-call
// usage stamping (docs/call-hooks.md, "Analysing calls with a service key").
// The subagent runner is stubbed: these tests are about who may invoke what,
// and which organisation and call the usage rows are attributed to.
import { jest } from '@jest/globals';
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';
import { randomUUID } from 'node:crypto';
// A decision agent must carry its one `result` function to save (lib/decision-limits.js).
import { resultFunction } from './fixtures/typesafe/six-questions.mjs';

// Short enough for the timeout test, long enough for every other stubbed run.
process.env.SUBAGENT_TIMEOUT = '300';

const runSubagent = jest.fn();
class SubagentError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'SubagentError'; this.status = status; }
}
// The runner is stubbed; the organisation gate is the real rule, restated here because the whole module is mocked.
async function organisationAllowsModel(agent) {
  if (!agent?.organisationId) return true;
  const { Organisation } = await import('../lib/database.js');
  const { ORGANISATION_RBAC_ATTRIBUTES } = await import('../lib/auth/permissions.js');
  const { effectiveAllowedModels, isModelAllowed } = await import('../lib/auth/model-access.js');
  const org = await Organisation.findByPk(agent.organisationId, { attributes: ORGANISATION_RBAC_ATTRIBUTES });
  return isModelAllowed(agent.modelName, effectiveAllowedModels(null, org));
}
jest.unstable_mockModule('../lib/subagent.js', () => ({ runSubagent, SubagentError, organisationAllowsModel }));

const invokeModule = (await import('../api/paths/agents/{agentId}/invoke.js')).default;
const { Agent, Organisation, User, Call, UsageRecord } = await import('../lib/database.js');
const { effectiveAllowedModels } = await import('../lib/auth/model-access.js');

const mockLogger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return this; },
};
const agentInvoke = invokeModule(mockLogger).POST;

const JEV = 'text:typesafe/jev-1.13.0';
const GENERATIVE = 'text:anthropic/claude-opus-4-8';

const makeReq = (body = {}, params = {}) => ({ body, params, query: {}, headers: {}, log: mockLogger });
const makeRes = (user) => ({
  _status: 200, _body: null, locals: { user },
  status(code) { this._status = code; return this; },
  send(data) { this._body = data; return this; },
  json(data) { this._body = data; return this; },
});

async function waitFor(check, { attempts = 50, delayMs = 20 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return check();
}

const usageFor = (agentId) => [{
  agentId, provider: 'typesafe', model: 'jev-1.13.0',
  inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0,
}];

const mkCall = (organisationId, userId, index, fields = {}) => Call.create({
  organisationId, userId, index, parentId: null, modelName: 'livekit:openai/gpt-4o',
  calledId: '+442080996945', callerId: '+443300889471', status: 'ended normally', ...fields,
});

let orgA, orgB, jevAgentA, textAgentA, jevAgentB, userA, serviceUser, callA, callB, callBByUserA;

beforeAll(async () => {
  await setupRealDatabase();
  orgA = await Organisation.create({ id: randomUUID(), name: 'analysis-org-a' });
  orgB = await Organisation.create({ id: randomUUID(), name: 'analysis-org-b' });
  const mkUser = (fields) => User.create({
    id: randomUUID(), emailVerified: true, phone: '', phoneVerified: false, picture: '', status: 'active', ...fields,
  });
  userA = await mkUser({ name: 'Org A owner', email: `a-${randomUUID()}@example.com`, role: 'owner', organisationId: orgA.id });
  serviceUser = await mkUser({ name: 'Call Analysis Service', email: `svc-${randomUUID()}@aplisay.internal`, role: 'analysisService', organisationId: null });
  jevAgentA = await Agent.create({ name: 'Analyst A', type: 'text', modelName: JEV, prompt: 'Judge.', functions: [resultFunction()], organisationId: orgA.id, userId: userA.id });
  textAgentA = await Agent.create({ name: 'Writer A', type: 'text', modelName: GENERATIVE, prompt: 'Write.', organisationId: orgA.id, userId: userA.id });
  jevAgentB = await Agent.create({ name: 'Analyst B', type: 'text', modelName: JEV, prompt: 'Judge.', functions: [resultFunction()], organisationId: orgB.id });
  // A call that started a month ago: its start must not become the billing instant.
  callA = await mkCall(orgA.id, userA.id, 1, { startedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) });
  callB = await mkCall(orgB.id, null, 1);
  // A call the user made while in another organisation.
  callBByUserA = await mkCall(orgB.id, userA.id, 2);
}, 60000);

afterAll(async () => {
  await UsageRecord.destroy({ where: { organisationId: [orgA.id, orgB.id] } });
  await Call.destroy({ where: { organisationId: [orgA.id, orgB.id] } });
  await Agent.destroy({ where: { organisationId: [orgA.id, orgB.id] } });
  await User.destroy({ where: { id: [userA.id, serviceUser.id] } });
  await Organisation.destroy({ where: { id: [orgA.id, orgB.id] } });
  await teardownRealDatabase();
}, 60000);

beforeEach(() => {
  runSubagent.mockReset();
  runSubagent.mockImplementation(async ({ agent }) => ({
    result: { outcome: 'resolved' }, complete: true, transcript: [], usage: usageFor(agent.id),
  }));
});

// Principals as middleware/auth.js builds them: RBAC resolves from `role`, the model list from the role's default.
const service = () => ({ id: serviceUser.id, organisationId: null, role: 'analysisService', _allowedModels: effectiveAllowedModels(serviceUser, null) });
const ownerA = () => ({ id: userA.id, organisationId: orgA.id, role: 'owner', _allowedModels: null });
const orglessMember = () => ({ id: randomUUID(), organisationId: null, role: 'member', _allowedModels: null });

const rowsForCall = (callId) => waitFor(async () => {
  const rows = await UsageRecord.findAll({ where: { callId } });
  return rows.length >= 2 ? rows : null;
});

describe('invoke on behalf of an organisation', () => {
  test('the analysis service invokes an organisation\'s decision agent; usage lands on that organisation with the call, no user, and today\'s billing instant', async () => {
    const res = makeRes(service());
    await agentInvoke(makeReq({ input: { transcript: [] }, organisationId: orgA.id, callId: callA.id }, { agentId: jevAgentA.id }), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ result: { outcome: 'resolved' }, complete: true, transcript: [] });
    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(runSubagent.mock.calls[0][0].agent.id).toBe(jevAgentA.id);
    const rows = await rowsForCall(callA.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.organisationId).toBe(orgA.id);
      expect(row.userId).toBeNull();
      expect(row.agentId).toBe(jevAgentA.id);
      expect(row.finalised).toBe(true);
      expect(row.provider).toBe('typesafe');
      // Priced now, not at the cited call's start a month ago.
      expect(Math.abs(Date.now() - new Date(row.billedAt).getTime())).toBeLessThan(60_000);
    }
    expect(rows.map((r) => r.unit).sort()).toEqual(['input_tokens', 'output_tokens']);
  });

  test('the service key is confined to decision models by its role\'s model list', async () => {
    expect(service()._allowedModels).toEqual(['text:typesafe/']);
    const res = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id }, { agentId: textAgentA.id }), res);
    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ message: 'model_not_permitted' });
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test('a principal that belongs to an organisation may not send organisationId', async () => {
    const res = makeRes(ownerA());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id }, { agentId: jevAgentA.id }), res);
    expect(res._status).toBe(400);
    expect(res._body.message).toMatch(/accepted only from a principal with no organisation/);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test('an organisation-less principal without agent:readAll gets 403', async () => {
    const res = makeRes(orglessMember());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id }, { agentId: jevAgentA.id }), res);
    expect(res._status).toBe(403);
    expect(res._body.detail).toMatch(/agent:readAll/);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test('the agent is looked up in the named organisation only', async () => {
    const wrongOrg = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgB.id }, { agentId: jevAgentA.id }), wrongOrg);
    expect(wrongOrg._status).toBe(404);
    const badId = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: 'not-a-uuid' }, { agentId: jevAgentA.id }), badId);
    expect(badId._status).toBe(400);
    expect(badId._body.message).toMatch(/organisation UUID/);
    // Without organisationId the service owns no agents, so nothing is found.
    const noOrg = makeRes(service());
    await agentInvoke(makeReq({ input: {} }, { agentId: jevAgentA.id }), noOrg);
    expect(noOrg._status).toBe(404);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test('an inactive or billing-blocked organisation runs nothing', async () => {
    await orgB.update({ status: 'suspended' });
    try {
      const res = makeRes(service());
      await agentInvoke(makeReq({ input: {}, organisationId: orgB.id }, { agentId: jevAgentB.id }), res);
      expect(res._status).toBe(403);
      expect(res._body).toMatchObject({ message: 'organisation_inactive' });
    } finally {
      await orgB.update({ status: 'active' });
    }
    await orgB.update({ billingBlocked: true });
    try {
      const res = makeRes(service());
      await agentInvoke(makeReq({ input: {}, organisationId: orgB.id }, { agentId: jevAgentB.id }), res);
      expect(res._status).toBe(403);
      expect(res._body).toMatchObject({ message: 'billing_blocked' });
    } finally {
      await orgB.update({ billingBlocked: false });
    }
    expect(runSubagent).not.toHaveBeenCalled();
    const ok = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgB.id }, { agentId: jevAgentB.id }), ok);
    expect(ok._status).toBe(200);
  });

  test('the organisation\'s model floor applies, as it does for subagent dispatch', async () => {
    await orgA.update({ allowedModels: ['text:kimi'] });
    try {
      const res = makeRes(service());
      await agentInvoke(makeReq({ input: {}, organisationId: orgA.id }, { agentId: jevAgentA.id }), res);
      expect(res._status).toBe(403);
      expect(res._body).toMatchObject({ message: 'model_not_permitted' });
      expect(res._body.detail).toMatch(/not permitted for this organisation/);
      expect(runSubagent).not.toHaveBeenCalled();
    } finally {
      await orgA.update({ allowedModels: null });
    }
    const ok = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id }, { agentId: jevAgentA.id }), ok);
    expect(ok._status).toBe(200);
  });

  test('a callId must be a UUID of a call in the attributed organisation', async () => {
    const shape = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id, callId: 'call-1' }, { agentId: jevAgentA.id }), shape);
    expect(shape._status).toBe(400);
    expect(shape._body.message).toMatch(/call UUID/);
    const otherOrg = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id, callId: callB.id }, { agentId: jevAgentA.id }), otherOrg);
    expect(otherOrg._status).toBe(404);
    expect(otherOrg._body.message).toMatch(/Call .* not found/);
    const missing = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id, callId: randomUUID() }, { agentId: jevAgentA.id }), missing);
    expect(missing._status).toBe(404);
    expect(runSubagent).not.toHaveBeenCalled();
  });
});

describe('callId from an ordinary principal', () => {
  test('stamps the usage rows with the call, attributed to the principal and its organisation', async () => {
    const call = await mkCall(orgA.id, userA.id, 3);
    const res = makeRes(ownerA());
    await agentInvoke(makeReq({ input: {}, callId: call.id }, { agentId: textAgentA.id }), res);
    expect(res._status).toBe(200);
    const rows = await rowsForCall(call.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.organisationId).toBe(orgA.id);
      expect(row.userId).toBe(userA.id);
      expect(row.callId).toBe(call.id);
    }
  });

  test('a call in another organisation is not found, even one the user made there', async () => {
    const other = makeRes(ownerA());
    await agentInvoke(makeReq({ input: {}, callId: callB.id }, { agentId: textAgentA.id }), other);
    expect(other._status).toBe(404);
    const ownButElsewhere = makeRes(ownerA());
    await agentInvoke(makeReq({ input: {}, callId: callBByUserA.id }, { agentId: textAgentA.id }), ownButElsewhere);
    expect(ownButElsewhere._status).toBe(404);
    expect(runSubagent).not.toHaveBeenCalled();
    const plain = makeRes(ownerA());
    await agentInvoke(makeReq({ input: {} }, { agentId: textAgentA.id }), plain);
    expect(plain._status).toBe(200);
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });

  test('usage on a failed invocation is still stamped with the call', async () => {
    runSubagent.mockImplementation(async ({ agent }) => {
      throw Object.assign(new SubagentError('Subagent LLM error: boom', 502), { usage: usageFor(agent.id) });
    });
    const call = await mkCall(orgA.id, userA.id, 4);
    const res = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id, callId: call.id }, { agentId: jevAgentA.id }), res);
    expect(res._status).toBe(502);
    const rows = await rowsForCall(call.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.organisationId === orgA.id && r.userId === null)).toBe(true);
  });

  test('a run that outlives the timeout answers 504 and is still metered when it ends', async () => {
    runSubagent.mockImplementation(({ agent }) => new Promise((resolve) => {
      setTimeout(() => resolve({ result: {}, complete: true, transcript: [], usage: usageFor(agent.id) }), 600);
    }));
    const call = await mkCall(orgA.id, userA.id, 5);
    const res = makeRes(ownerA());
    await agentInvoke(makeReq({ input: {}, callId: call.id }, { agentId: textAgentA.id }), res);
    expect(res._status).toBe(504);
    expect(res._body.message).toMatch(/timed out/);
    const rows = await rowsForCall(call.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.callId === call.id && r.organisationId === orgA.id)).toBe(true);
  });
});
