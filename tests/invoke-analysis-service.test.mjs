// POST /agents/{agentId}/invoke on behalf of an organisation, and per-call
// usage stamping (docs/call-hooks.md, "Analysing calls with a service key").
// The subagent runner is stubbed: these tests are about who may invoke what,
// and where the usage rows land.
import { jest } from '@jest/globals';
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';
import { randomUUID } from 'node:crypto';

const runSubagent = jest.fn();
class SubagentError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'SubagentError'; this.status = status; }
}
jest.unstable_mockModule('../lib/subagent.js', () => ({ runSubagent, SubagentError }));

const invokeModule = (await import('../api/paths/agents/{agentId}/invoke.js')).default;
const { Agent, Organisation, User, Call, UsageRecord } = await import('../lib/database.js');

const mockLogger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return this; },
};
const agentInvoke = invokeModule(mockLogger).POST;

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
  agentId, provider: 'anthropic', model: 'claude-opus-4-8',
  inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0,
}];

let orgA, orgB, agentA, agentB, userA, serviceUser, callA, callB;

beforeAll(async () => {
  await setupRealDatabase();
  orgA = await Organisation.create({ id: randomUUID(), name: 'analysis-org-a' });
  orgB = await Organisation.create({ id: randomUUID(), name: 'analysis-org-b' });
  const mkUser = (fields) => User.create({
    id: randomUUID(), emailVerified: true, phone: '', phoneVerified: false, picture: '', status: 'active', ...fields,
  });
  userA = await mkUser({ name: 'Org A owner', email: `a-${randomUUID()}@example.com`, role: 'owner', organisationId: orgA.id });
  serviceUser = await mkUser({ name: 'Call Analysis Service', email: `svc-${randomUUID()}@aplisay.internal`, role: 'analysisService', organisationId: null });
  agentA = await Agent.create({ name: 'Analyst A', type: 'text', modelName: 'text:anthropic/claude-opus-4-8', prompt: 'Judge.', organisationId: orgA.id, userId: userA.id });
  agentB = await Agent.create({ name: 'Analyst B', type: 'text', modelName: 'text:anthropic/claude-opus-4-8', prompt: 'Judge.', organisationId: orgB.id });
  const mkCall = (organisationId, userId) => Call.create({
    organisationId, userId, index: 1, parentId: null, modelName: 'livekit:openai/gpt-4o',
    calledId: '+442080996945', callerId: '+443300889471', status: 'ended normally',
  });
  callA = await mkCall(orgA.id, userA.id);
  callB = await mkCall(orgB.id, null);
}, 60000);

afterAll(async () => {
  await UsageRecord.destroy({ where: { organisationId: [orgA.id, orgB.id] } });
  await Call.destroy({ where: { id: [callA.id, callB.id] } });
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

// Principals: RBAC resolves from `role` when _effectivePermissions is not precomputed.
const service = () => ({ id: serviceUser.id, organisationId: null, role: 'analysisService', _allowedModels: null });
const ownerA = () => ({ id: userA.id, organisationId: orgA.id, role: 'owner', _allowedModels: null });
const orglessMember = () => ({ id: randomUUID(), organisationId: null, role: 'member', _allowedModels: null });

const rowsForCall = (callId) => waitFor(async () => {
  const rows = await UsageRecord.findAll({ where: { callId } });
  return rows.length >= 2 ? rows : null;
});

describe('invoke on behalf of an organisation', () => {
  test('the analysis service invokes an organisation\'s agent; usage lands on that organisation with the call and no user', async () => {
    const res = makeRes(service());
    await agentInvoke(makeReq({ input: { transcript: [] }, organisationId: orgA.id, callId: callA.id }, { agentId: agentA.id }), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ result: { outcome: 'resolved' }, complete: true, transcript: [] });
    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(runSubagent.mock.calls[0][0].agent.id).toBe(agentA.id);
    const rows = await rowsForCall(callA.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.organisationId).toBe(orgA.id);
      expect(row.userId).toBeNull();
      expect(row.agentId).toBe(agentA.id);
      expect(row.finalised).toBe(true);
      expect(row.provider).toBe('anthropic');
    }
    expect(rows.map((r) => r.unit).sort()).toEqual(['input_tokens', 'output_tokens']);
  });

  test('a principal that belongs to an organisation may not send organisationId', async () => {
    const res = makeRes(ownerA());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id }, { agentId: agentA.id }), res);
    expect(res._status).toBe(400);
    expect(res._body.message).toMatch(/accepted only from a principal with no organisation/);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test('an organisation-less principal without agent:readAll gets 403', async () => {
    const res = makeRes(orglessMember());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id }, { agentId: agentA.id }), res);
    expect(res._status).toBe(403);
    expect(res._body.detail).toMatch(/agent:readAll/);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test('the agent is looked up in the named organisation only', async () => {
    const wrongOrg = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgB.id }, { agentId: agentA.id }), wrongOrg);
    expect(wrongOrg._status).toBe(404);
    const badId = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: 'not-a-uuid' }, { agentId: agentA.id }), badId);
    expect(badId._status).toBe(400);
    expect(badId._body.message).toMatch(/organisation UUID/);
    // Without organisationId the service owns no agents, so nothing is found.
    const noOrg = makeRes(service());
    await agentInvoke(makeReq({ input: {} }, { agentId: agentA.id }), noOrg);
    expect(noOrg._status).toBe(404);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test('the organisation\'s model floor applies, as it does for subagent dispatch', async () => {
    await orgA.update({ allowedModels: ['text:kimi'] });
    try {
      const res = makeRes(service());
      await agentInvoke(makeReq({ input: {}, organisationId: orgA.id }, { agentId: agentA.id }), res);
      expect(res._status).toBe(403);
      expect(res._body).toMatchObject({ message: 'model_not_permitted' });
      expect(res._body.detail).toMatch(/not permitted for this organisation/);
      expect(runSubagent).not.toHaveBeenCalled();
    } finally {
      await orgA.update({ allowedModels: null });
    }
    const ok = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id }, { agentId: agentA.id }), ok);
    expect(ok._status).toBe(200);
  });

  test('a callId must be a UUID of a call in the attributed organisation', async () => {
    const shape = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id, callId: 'call-1' }, { agentId: agentA.id }), shape);
    expect(shape._status).toBe(400);
    expect(shape._body.message).toMatch(/call UUID/);
    const otherOrg = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id, callId: callB.id }, { agentId: agentA.id }), otherOrg);
    expect(otherOrg._status).toBe(404);
    expect(otherOrg._body.message).toMatch(/Call .* not found/);
    const missing = makeRes(service());
    await agentInvoke(makeReq({ input: {}, organisationId: orgA.id, callId: randomUUID() }, { agentId: agentA.id }), missing);
    expect(missing._status).toBe(404);
    expect(runSubagent).not.toHaveBeenCalled();
  });
});

describe('callId from an ordinary principal', () => {
  test('stamps the usage rows with the call, attributed to the principal and its organisation', async () => {
    // A second call so the rows are distinguishable from the service-path test above.
    const call = await Call.create({
      organisationId: orgA.id, userId: userA.id, index: 2, parentId: null, modelName: 'livekit:openai/gpt-4o',
      calledId: '+442080996945', callerId: '+443300889471', status: 'ended normally',
    });
    try {
      const res = makeRes(ownerA());
      await agentInvoke(makeReq({ input: {}, callId: call.id }, { agentId: agentA.id }), res);
      expect(res._status).toBe(200);
      const rows = await rowsForCall(call.id);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.organisationId).toBe(orgA.id);
        expect(row.userId).toBe(userA.id);
        expect(row.callId).toBe(call.id);
      }
    } finally {
      await UsageRecord.destroy({ where: { callId: call.id } });
      await Call.destroy({ where: { id: call.id } });
    }
  });

  test('a call in another organisation is not found; without callId nothing changes', async () => {
    const other = makeRes(ownerA());
    await agentInvoke(makeReq({ input: {}, callId: callB.id }, { agentId: agentA.id }), other);
    expect(other._status).toBe(404);
    expect(runSubagent).not.toHaveBeenCalled();
    const plain = makeRes(ownerA());
    await agentInvoke(makeReq({ input: {} }, { agentId: agentA.id }), plain);
    expect(plain._status).toBe(200);
    expect(runSubagent).toHaveBeenCalledTimes(1);
  });

  test('usage on a failed invocation is still stamped with the call', async () => {
    runSubagent.mockImplementation(async ({ agent }) => {
      throw Object.assign(new SubagentError('Subagent LLM error: boom', 502), { usage: usageFor(agent.id) });
    });
    const call = await Call.create({
      organisationId: orgA.id, userId: userA.id, index: 3, parentId: null, modelName: 'livekit:openai/gpt-4o',
      calledId: '+442080996945', callerId: '+443300889471', status: 'ended normally',
    });
    try {
      const res = makeRes(service());
      await agentInvoke(makeReq({ input: {}, organisationId: orgA.id, callId: call.id }, { agentId: agentA.id }), res);
      expect(res._status).toBe(502);
      const rows = await rowsForCall(call.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.organisationId === orgA.id && r.userId === null)).toBe(true);
    } finally {
      await UsageRecord.destroy({ where: { callId: call.id } });
      await Call.destroy({ where: { id: call.id } });
    }
  });
});
