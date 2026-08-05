import { setupRealDatabase, teardownRealDatabase, Agent, User, Organisation } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * Listener-level transfer overrides (docs/transfer-back-plan.md):
 * `POST /agents/{id}/listen` options may carry bridgedTransferToAgent /
 * bridgedTransferTranscribe / dtmfTimeout, wholesale-replacing the agent's
 * options for that listener. This suite exercises the validation + label
 * resolution funnel (`resolveListenerTransferOverrides`) directly.
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
  const res = {
    locals: { user },
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
    json(payload) { this.body = payload; return this; }
  };
  return res;
}

const VOICE_MODEL = 'livekit:ultravox/ultravox-70b';
const TEXT_MODEL = 'text:openai/gpt-4o';

// Capability flags as the pipecat/livekit handler classes expose them
const transferHandler = { hasTransfer: true, hasAgentTransfer: true };
const noTransferHandler = { hasTransfer: false, hasAgentTransfer: false };

function setDocument() {
  return {
    name: 'Hand-back office',
    description: 'Front desk with follow-up and researcher',
    agents: [
      {
        label: 'frontdesk',
        name: 'Front desk',
        modelName: VOICE_MODEL,
        prompt: 'You answer the phone.'
      },
      {
        label: 'followup',
        name: 'Follow-up booking',
        modelName: VOICE_MODEL,
        prompt: 'You book the follow-up.'
      },
      {
        label: 'researcher',
        name: 'Research agent',
        modelName: TEXT_MODEL,
        type: 'text',
        prompt: 'You research questions.'
      }
    ]
  };
}

describe('Listener transfer overrides', () => {
  let user;
  let createAgentSet, createAgent;
  let resolveListenerTransferOverrides;

  beforeAll(async () => {
    await setupRealDatabase();
    const collection = (await import('../api/paths/agent-sets.js')).default(mockLogger);
    const agents = (await import('../api/paths/agents.js')).default(mockLogger, {}, {});
    createAgentSet = collection.POST;
    createAgent = agents.POST;
    ({ resolveListenerTransferOverrides } = await import('../lib/listener-transfer-overrides.js'));
  }, 60000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    const org = await Organisation.create({ id: randomUUID(), name: 'Listener Override Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'Listener Override Tester',
      email: 'listener-overrides@test.example.com',
      emailVerified: true,
      phone: '+15550000001',
      phoneVerified: false,
      picture: '',
      role: 'owner',
      organisationId: org.id
    });
    user = { id: dbUser.id, organisationId: org.id, role: 'owner' };
  });

  async function makeSet() {
    const res = makeRes(user);
    await createAgentSet(makeReq(setDocument()), res);
    expect(res.statusCode).toBe(200);
    const byLabel = Object.fromEntries(res.body.agents.map((a) => [a.label, a]));
    // Reload the frontdesk member as a real row (the resolver expects an agent row)
    const frontdesk = await Agent.findByPk(byLabel.frontdesk.id);
    return { byLabel, frontdesk };
  }

  test('resolves label references against the agent set and stamps fromLabel', async () => {
    const { byLabel, frontdesk } = await makeSet();
    const resolved = await resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: transferHandler,
      bridgedTransferToAgent: { '1': 'label:followup', '*7': { agent: 'label:frontdesk', includeHistory: false } }
    });
    expect(resolved.bridgedTransferToAgent['1']).toEqual({ agent: byLabel.followup.id, fromLabel: 'followup' });
    expect(resolved.bridgedTransferToAgent['*7']).toEqual({
      agent: byLabel.frontdesk.id,
      includeHistory: false,
      fromLabel: 'frontdesk'
    });
  });

  test('accepts plain UUID targets on a set-less agent', async () => {
    const targetRes = makeRes(user);
    await createAgent(makeReq({ name: 'Target', modelName: VOICE_MODEL, prompt: 'x' }), targetRes);
    expect(targetRes.statusCode).toBe(200);
    const sourceRes = makeRes(user);
    await createAgent(makeReq({ name: 'Source', modelName: VOICE_MODEL, prompt: 'x' }), sourceRes);
    const source = await Agent.findByPk(sourceRes.body.id);

    const resolved = await resolveListenerTransferOverrides({
      agent: source,
      Handler: transferHandler,
      bridgedTransferToAgent: { '2': targetRes.body.id },
      bridgedTransferTranscribe: true,
      dtmfTimeout: 900
    });
    expect(resolved.bridgedTransferToAgent['2']).toEqual({ agent: targetRes.body.id });
    expect(resolved.bridgedTransferTranscribe).toBe(true);
    expect(resolved.dtmfTimeout).toBe(900);
  });

  test('rejects label references when the agent is not in a set', async () => {
    const res = makeRes(user);
    await createAgent(makeReq({ name: 'Loner', modelName: VOICE_MODEL, prompt: 'x' }), res);
    const agent = await Agent.findByPk(res.body.id);
    await expect(resolveListenerTransferOverrides({
      agent,
      Handler: transferHandler,
      bridgedTransferToAgent: { '1': 'label:followup' }
    })).rejects.toThrow(/not a member of an agent set/);
  });

  test('rejects an unknown label', async () => {
    const { frontdesk } = await makeSet();
    await expect(resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: transferHandler,
      bridgedTransferToAgent: { '1': 'label:nonexistent' }
    })).rejects.toThrow(/references label "nonexistent"/);
  });

  test('rejects a text-agent hand-back target', async () => {
    const { frontdesk } = await makeSet();
    await expect(resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: transferHandler,
      bridgedTransferToAgent: { '1': 'label:researcher' }
    })).rejects.toThrow(/must target a interactive-audio agent/);
  });

  test('rejects a target outside the organisation', async () => {
    const { frontdesk } = await makeSet();
    const otherOrg = await Organisation.create({ id: randomUUID(), name: 'Other Org' });
    const foreign = await Agent.create({
      id: randomUUID(),
      name: 'Foreign',
      modelName: VOICE_MODEL,
      prompt: 'x',
      userId: user.id,
      organisationId: otherOrg.id
    });
    await expect(resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: transferHandler,
      bridgedTransferToAgent: { '1': foreign.id }
    })).rejects.toThrow(/does not exist or is not accessible/);
  });

  test('rejects the option on a non-transfer handler', async () => {
    const { byLabel, frontdesk } = await makeSet();
    await expect(resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: noTransferHandler,
      bridgedTransferToAgent: { '1': byLabel.followup.id }
    })).rejects.toThrow(/does not support bridged transfers to agents/);
  });

  test('rejects malformed DTMF keys and shapes', async () => {
    const { byLabel, frontdesk } = await makeSet();
    await expect(resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: transferHandler,
      bridgedTransferToAgent: { 'abc': byLabel.followup.id }
    })).rejects.toThrow(/must be a DTMF sequence/);
    await expect(resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: transferHandler,
      bridgedTransferToAgent: []
    })).rejects.toThrow(/must be an object mapping DTMF sequences/);
  });

  test('validates dtmfTimeout bounds and transcribe shape', async () => {
    const { frontdesk } = await makeSet();
    await expect(resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: transferHandler,
      dtmfTimeout: 50
    })).rejects.toThrow(/options.dtmfTimeout must be an integer/);
    await expect(resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: transferHandler,
      bridgedTransferTranscribe: { provider: 'unsupported-vendor' }
    })).rejects.toThrow(/provider must be one of/);
  });

  test('returns nothing when no overrides are supplied', async () => {
    const { frontdesk } = await makeSet();
    const resolved = await resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: transferHandler
    });
    expect(resolved).toEqual({});
  });

  test('does not mutate the caller-supplied map', async () => {
    const { frontdesk } = await makeSet();
    const supplied = { '1': 'label:followup' };
    await resolveListenerTransferOverrides({
      agent: frontdesk,
      Handler: transferHandler,
      bridgedTransferToAgent: supplied
    });
    expect(supplied).toEqual({ '1': 'label:followup' });
  });
});
