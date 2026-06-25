import { setupRealDatabase, teardownRealDatabase, Agent, AgentSet, User, Organisation } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * Agent set lifecycle: create a group of agents from one document with
 * label-based cross references, read it back, update it as a group, and
 * delete it as a group.
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

function transferAgentFunction(target, { includeHistory = true } = {}) {
  return {
    name: 'transfer_to_specialist',
    implementation: 'builtin',
    platform: 'transfer_agent',
    description: 'Hand the call to the specialist agent',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', source: 'static', from: target },
        includeHistory: { type: 'boolean', source: 'static', from: includeHistory },
        summary: { type: 'string', description: 'Short handover summary for the next agent' }
      }
    }
  };
}

function subagentFunction(target) {
  return {
    name: 'ask_researcher',
    implementation: 'builtin',
    platform: 'subagent',
    description: 'Ask the research agent a question',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', source: 'static', from: target },
        question: { type: 'string', description: 'The question to research', required: true }
      }
    }
  };
}

function resultFunction() {
  return {
    name: 'deliver_result',
    implementation: 'builtin',
    platform: 'result',
    description: 'Deliver the research result',
    input_schema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The answer', required: true }
      }
    }
  };
}

function setDocument() {
  return {
    name: 'Front office',
    description: 'Triage plus specialist with research subagent',
    agents: [
      {
        label: 'triage',
        name: 'Triage agent',
        modelName: VOICE_MODEL,
        prompt: 'You answer the phone and route callers.',
        functions: [transferAgentFunction('label:specialist'), subagentFunction('label:researcher')]
      },
      {
        label: 'specialist',
        name: 'Specialist agent',
        modelName: VOICE_MODEL,
        prompt: 'You handle specialist enquiries.',
        functions: [transferAgentFunction('label:triage', { includeHistory: false })]
      },
      {
        label: 'researcher',
        name: 'Research agent',
        modelName: TEXT_MODEL,
        type: 'text',
        prompt: 'You research questions and return concise answers.',
        functions: [resultFunction()]
      }
    ]
  };
}

describe('Agent sets', () => {
  let user;
  let createAgentSet, listAgentSets, getAgentSet, updateAgentSet, deleteAgentSet;
  let createAgent;

  beforeAll(async () => {
    await setupRealDatabase();

    const collection = (await import('../api/paths/agent-sets.js')).default(mockLogger);
    const item = (await import('../api/paths/agent-sets/{agentSetId}.js')).default(mockLogger);
    const agents = (await import('../api/paths/agents.js')).default(mockLogger, {}, {});
    createAgentSet = collection.POST;
    listAgentSets = collection.GET;
    getAgentSet = item.GET;
    updateAgentSet = item.PUT;
    deleteAgentSet = item.DELETE;
    createAgent = agents.POST;
  }, 60000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    const org = await Organisation.create({ id: randomUUID(), name: 'Agent Set Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'Agent Set Tester',
      email: 'sets@test.example.com',
      emailVerified: true,
      phone: '+15550000000',
      phoneVerified: false,
      picture: '',
      role: 'owner',
      organisationId: org.id
    });
    user = { id: dbUser.id, organisationId: org.id, role: 'owner' };
  });

  test('creates a set, fixing up label references to member UUIDs', async () => {
    const res = makeRes(user);
    await createAgentSet(makeReq(setDocument()), res);

    expect(res.statusCode).toBe(200);
    const set = res.body;
    expect(set.id).toBeDefined();
    expect(set.agents).toHaveLength(3);

    const byLabel = Object.fromEntries(set.agents.map((a) => [a.label, a]));
    expect(byLabel.triage).toBeDefined();
    expect(byLabel.specialist).toBeDefined();
    expect(byLabel.researcher.type).toBe('text');

    // Label references resolved to UUIDs, original label preserved
    const transferParam = byLabel.triage.functions.find((f) => f.platform === 'transfer_agent').input_schema.properties.agent;
    expect(transferParam.from).toBe(byLabel.specialist.id);
    expect(transferParam.fromLabel).toBe('specialist');

    const subagentParam = byLabel.triage.functions.find((f) => f.platform === 'subagent').input_schema.properties.agent;
    expect(subagentParam.from).toBe(byLabel.researcher.id);
    expect(subagentParam.fromLabel).toBe('researcher');

    // Reverse reference (specialist -> triage) also resolved
    const reverseParam = byLabel.specialist.functions.find((f) => f.platform === 'transfer_agent').input_schema.properties.agent;
    expect(reverseParam.from).toBe(byLabel.triage.id);

    // Keys are never returned
    expect(set.agents.every((a) => a.keys === undefined)).toBe(true);

    // Members exist as ordinary agents
    const triage = await Agent.findByPk(byLabel.triage.id);
    expect(triage.agentSetId).toBe(set.id);
    expect(triage.label).toBe('triage');
  });

  test('rejects a set referencing an unknown label, leaving nothing behind', async () => {
    const doc = setDocument();
    doc.agents[0].functions[0].input_schema.properties.agent.from = 'label:nonexistent';
    const res = makeRes(user);
    await createAgentSet(makeReq(doc), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/label "nonexistent"/);
    // Transactional: no set and no agents persisted
    expect(await AgentSet.count({ where: { organisationId: user.organisationId } })).toBe(0);
    expect(await Agent.count({ where: { organisationId: user.organisationId } })).toBe(0);
  });

  test('rejects duplicate labels', async () => {
    const doc = setDocument();
    doc.agents[1].label = 'triage';
    const res = makeRes(user);
    await createAgentSet(makeReq(doc), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Duplicate agent label/);
  });

  test('rejects a subagent reference to a non-text agent', async () => {
    const doc = setDocument();
    // Point the subagent function at the (voice) specialist instead of the researcher
    doc.agents[0].functions[1].input_schema.properties.agent.from = 'label:specialist';
    const res = makeRes(user);
    await createAgentSet(makeReq(doc), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/must target a text agent/);
  });

  test('lists and gets sets', async () => {
    const createRes = makeRes(user);
    await createAgentSet(makeReq(setDocument()), createRes);
    expect(createRes.statusCode).toBe(200);

    const listRes = makeRes(user);
    await listAgentSets(makeReq(), listRes);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.agentSets).toHaveLength(1);
    expect(listRes.body.agentSets[0].agents).toHaveLength(3);

    const getRes = makeRes(user);
    await getAgentSet(makeReq({}, { agentSetId: createRes.body.id }), getRes);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.agents).toHaveLength(3);
  });

  test('updates a set as a group: add, update, remove, and re-fixup', async () => {
    const createRes = makeRes(user);
    await createAgentSet(makeReq(setDocument()), createRes);
    expect(createRes.statusCode).toBe(200);
    const original = Object.fromEntries(createRes.body.agents.map((a) => [a.label, a]));

    // New document: drop the researcher, add a billing agent, retarget triage at it,
    //  and update the specialist prompt.
    const doc = {
      name: 'Front office v2',
      agents: [
        {
          label: 'triage',
          name: 'Triage agent',
          modelName: VOICE_MODEL,
          prompt: 'You answer the phone and route callers.',
          functions: [transferAgentFunction('label:billing')]
        },
        {
          label: 'specialist',
          name: 'Specialist agent',
          modelName: VOICE_MODEL,
          prompt: 'You handle specialist enquiries v2.',
          functions: [transferAgentFunction('label:triage', { includeHistory: false })]
        },
        {
          label: 'billing',
          name: 'Billing agent',
          modelName: VOICE_MODEL,
          prompt: 'You handle billing.',
          functions: []
        }
      ]
    };

    const updateRes = makeRes(user);
    await updateAgentSet(makeReq(doc, { agentSetId: createRes.body.id }), updateRes);
    expect(updateRes.statusCode).toBe(200);
    const updated = Object.fromEntries(updateRes.body.agents.map((a) => [a.label, a]));

    expect(updateRes.body.name).toBe('Front office v2');
    expect(updateRes.body.agents).toHaveLength(3);
    // Stable identities for retained labels
    expect(updated.triage.id).toBe(original.triage.id);
    expect(updated.specialist.id).toBe(original.specialist.id);
    expect(updated.specialist.prompt).toBe('You handle specialist enquiries v2.');
    // Removed member is gone
    expect(await Agent.findByPk(original.researcher.id)).toBeNull();
    // New member created and reference resolved to it
    const billingRef = updated.triage.functions.find((f) => f.platform === 'transfer_agent').input_schema.properties.agent;
    expect(billingRef.from).toBe(updated.billing.id);
  });

  test('round-trips: GET output PUT back resolves fromLabel annotations', async () => {
    const createRes = makeRes(user);
    await createAgentSet(makeReq(setDocument()), createRes);
    const set = createRes.body;

    // PUT back exactly what GET returned (labels still resolve via fromLabel)
    const doc = {
      name: set.name,
      agents: set.agents.map(({ label, name, modelName, prompt, options, functions, type }) =>
        ({ label, name, modelName, prompt, options, functions, type }))
    };
    const updateRes = makeRes(user);
    await updateAgentSet(makeReq(doc, { agentSetId: set.id }), updateRes);
    expect(updateRes.statusCode).toBe(200);
    const updated = Object.fromEntries(updateRes.body.agents.map((a) => [a.label, a]));
    const transferParam = updated.triage.functions.find((f) => f.platform === 'transfer_agent').input_schema.properties.agent;
    expect(transferParam.from).toBe(updated.specialist.id);
  });

  test('deletes a set and all its members', async () => {
    const createRes = makeRes(user);
    await createAgentSet(makeReq(setDocument()), createRes);
    const setId = createRes.body.id;
    const memberIds = createRes.body.agents.map((a) => a.id);

    const deleteRes = makeRes(user);
    await deleteAgentSet(makeReq({}, { agentSetId: setId }), deleteRes);
    expect(deleteRes.statusCode).toBe(200);

    expect(await AgentSet.findByPk(setId)).toBeNull();
    for (const id of memberIds) {
      expect(await Agent.findByPk(id)).toBeNull();
    }
  });

  test('scopes sets to their owner', async () => {
    const createRes = makeRes(user);
    await createAgentSet(makeReq(setDocument()), createRes);

    const stranger = { id: randomUUID(), organisationId: null, role: 'owner' };
    const getRes = makeRes(stranger);
    await getAgentSet(makeReq({}, { agentSetId: createRes.body.id }), getRes);
    expect(getRes.statusCode).toBe(404);
  });

  test('plain POST /agents rejects label references and unknown targets', async () => {
    // Labels are only valid inside an agent-set document
    const labelRes = makeRes(user);
    await createAgent(makeReq({
      modelName: VOICE_MODEL,
      prompt: 'voice agent',
      functions: [transferAgentFunction('label:other')]
    }), labelRes);
    expect(labelRes.statusCode).toBe(400);

    // A syntactically valid UUID that doesn't exist is rejected too
    const missingRes = makeRes(user);
    await createAgent(makeReq({
      modelName: VOICE_MODEL,
      prompt: 'voice agent',
      functions: [transferAgentFunction(randomUUID())]
    }), missingRes);
    expect(missingRes.statusCode).toBe(400);
    expect(missingRes.body.message).toMatch(/does not exist/);
  });

  test('POST /agents accepts a text agent with a result function and defaults its type', async () => {
    const res = makeRes(user);
    await createAgent(makeReq({
      modelName: TEXT_MODEL,
      prompt: 'You research things.',
      functions: [resultFunction()]
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.type).toBe('text');
  });

  test('POST /agents accepts transfer_agent and subagent builtins on pipecat agents', async () => {
    // Create the targets first (a voice agent and a text agent), then a
    // pipecat agent referencing both.
    const voiceRes = makeRes(user);
    await createAgent(makeReq({ modelName: 'pipecat:openai/gpt-4o', prompt: 'voice target' }), voiceRes);
    expect(voiceRes.statusCode).toBe(200);
    const textRes = makeRes(user);
    await createAgent(makeReq({ modelName: TEXT_MODEL, prompt: 'researcher', functions: [resultFunction()] }), textRes);
    expect(textRes.statusCode).toBe(200);

    const res = makeRes(user);
    await createAgent(makeReq({
      modelName: 'pipecat:openai/gpt-4o',
      prompt: 'front desk',
      functions: [
        transferAgentFunction(voiceRes.body.id),
        subagentFunction(textRes.body.id)
      ]
    }), res);
    expect(res.statusCode).toBe(200);
  });

  test('POST /agents rejects a result function on a voice agent', async () => {
    const res = makeRes(user);
    await createAgent(makeReq({
      modelName: VOICE_MODEL,
      prompt: 'voice agent',
      functions: [resultFunction()]
    }), res);
    expect(res.statusCode).toBe(400);
  });
});
