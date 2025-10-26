import { setupRealDatabase, teardownRealDatabase, Agent, Instance, PhoneNumber, PhoneRegistration, Call, TransactionLog, User, Organisation, AuthKey, Trunk, Op, Sequelize, databaseStarted, stopDatabase } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import aplisayTestAgentBase from './fixtures/aplisayTestAgentBase.js';

describe('Listener Join and Originate Endpoints Test', () => {
  let models;
  let testOrgId;
  let testUserId;
  let testTrunkId;
  let testAgentId;
  let testPhoneNumberId;
  let testRegistrationId;
  let testWebRTCListenerId;
  let testPhoneListenerId;
  let testRegistrationListenerId;

  // API endpoint handlers
  let createAgent;
  let createPhoneEndpoint;
  let activateRegistration;
  let createListener;
  let deleteListener;
  let deleteAgent;
  let deletePhoneEndpoint;
  let joinListener;
  let originateCall;

  // Mock objects for API endpoints
  let mockLogger;
  let mockVoices;
  let mockWsServer;

  beforeAll(async () => {
    // Connect to real database
    await setupRealDatabase();
    models = { Agent, Instance, PhoneNumber, PhoneRegistration, Call, TransactionLog, User, Organisation, AuthKey, Trunk };

    // Import API endpoints after database is set up
    const agentsModule = await import('../api/paths/agents.js');
    const phoneEndpointsModule = await import('../api/paths/phone-endpoints.js');
    const activateModule = await import('../api/paths/phone-endpoints/{identifier}/activate.js');
    const listenModule = await import('../api/paths/agents/{agentId}/listen.js');
    const deleteListenerModule = await import('../api/paths/listener/{listenerId}.js');
    const deleteAgentModule = await import('../api/paths/agents/{agentId}.js');
    const joinModule = await import('../api/paths/listener/{listenerId}/join.js');
    const originateModule = await import('../api/paths/listener/{listenerId}/originate.js');

    // Create mock logger and other dependencies
    mockLogger = {
      info: () => {},
      error: () => {},
      debug: () => {},
      child: () => mockLogger
    };
    mockVoices = {};
    mockWsServer = {
      emit: () => {},
      on: () => {},
      off: () => {}
    };

    // Initialize the API endpoints
    const agents = agentsModule.default(mockLogger, mockVoices, mockWsServer);
    const phoneEndpoints = phoneEndpointsModule.default(mockLogger, mockVoices, mockWsServer);
    const activateHandler = activateModule.default(mockLogger, mockVoices, mockWsServer);
    const listenHandler = listenModule.default(mockWsServer);
    const deleteListenerHandler = deleteListenerModule.default(mockLogger, mockVoices, mockWsServer);
    const deleteAgentHandler = deleteAgentModule.default(mockLogger, mockVoices, mockWsServer);
    const joinHandler = joinModule.default();
    const originateHandler = originateModule.default(mockLogger, mockVoices, mockWsServer);

    createAgent = agents.POST;
    createPhoneEndpoint = phoneEndpoints.POST;
    activateRegistration = activateHandler.POST;
    createListener = listenHandler.POST;
    deleteListener = deleteListenerHandler.DELETE;
    deleteAgent = deleteAgentHandler.DELETE;
    deletePhoneEndpoint = phoneEndpoints.DELETE;
    joinListener = joinHandler.POST;
    originateCall = originateHandler.POST;
  }, 30000);

  afterAll(async () => {
    // Disconnect from real database
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    const { Organisation, User, Trunk } = models;
    
    // Create test organisation
    const testOrg = await Organisation.create({
      id: randomUUID(),
      name: 'Test Organisation',
      slug: `test-org-${Date.now()}`
    });
    testOrgId = testOrg.id;

    // Create test user
    const testUser = await User.create({
      id: randomUUID(),
      organisationId: testOrgId,
      email: `test-${Date.now()}@example.com`,
      name: 'Test User'
    });
    testUserId = testUser.id;

    // Create test trunk
    const testTrunk = await Trunk.create({
      id: `test-trunk-${Date.now()}`,
      name: 'Test Trunk',
      outbound: true
    });
    await testTrunk.addOrganisation(testOrgId);
    testTrunkId = testTrunk.id;
  });

  afterEach(async () => {
    // Clean up test data
    const { Organisation, User, Agent, PhoneNumber, PhoneRegistration, Trunk, Instance } = models;
    
    if (testOrgId) {
      await Instance.destroy({ where: { agentId: testAgentId } });
      await Agent.destroy({ where: { organisationId: testOrgId } });
      await PhoneNumber.destroy({ where: { organisationId: testOrgId } });
      await PhoneRegistration.destroy({ where: { organisationId: testOrgId } });
      await User.destroy({ where: { organisationId: testOrgId } });
      if (testTrunkId) {
        await Trunk.destroy({ where: { id: testTrunkId } });
      }
      await Organisation.destroy({ where: { id: testOrgId } });
    }
  });

  // Helper function to create mock request
  const createMockRequest = (options = {}) => ({
    body: {},
    params: {},
    query: {},
    headers: {},
    log: mockLogger,
    ...options
  });

  // Helper function to create mock response
  const createMockResponse = () => {
    const res = {
      _status: null,
      _body: null,
      locals: {}
    };
    
    res.status = (code) => {
      res._status = code;
      return res;
    };
    
    res.send = (body) => {
      res._body = body;
      return res;
    };
    
    res.set = (key, value) => {
      res.headers = res.headers || {};
      res.headers[key] = value;
      return res;
    };
    
    return res;
  };

  // Helper function to create agent
  const createTestAgent = async () => {
    const convertedFunctions = {};
    aplisayTestAgentBase.functions.forEach(func => {
      const properties = {};
      func.parameters.forEach(param => {
        properties[param.name] = {
          type: param.type,
          source: param.source,
          from: param.from,
          description: param.description
        };
      });

      convertedFunctions[func.name] = {
        implementation: func.implementation,
        platform: func.platform,
        name: func.name,
        description: func.description,
        input_schema: {
          properties: properties
        }
      };
    });

    const agentReq = createMockRequest({
      body: {
        name: aplisayTestAgentBase.name,
        description: aplisayTestAgentBase.description,
        modelName: aplisayTestAgentBase.modelName,
        prompt: aplisayTestAgentBase.prompt.value,
        options: aplisayTestAgentBase.options,
        functions: convertedFunctions,
        keys: aplisayTestAgentBase.keys
      }
    });
    const agentRes = createMockResponse();
    agentRes.locals.user = { id: testUserId, organisationId: testOrgId };

    await createAgent(agentReq, agentRes);
    testAgentId = agentRes._body.id;
    return testAgentId;
  };

  // Helper function to create phone number
  const createTestPhoneNumber = async () => {
    const phoneReq = createMockRequest({
      body: {
        type: 'e164-ddi',
        number: '+1234567890',
        handler: 'livekit',
        outbound: true, // Enable outbound for originate testing
        trunkId: testTrunkId
      }
    });
    const phoneRes = createMockResponse();
    phoneRes.locals.user = { organisationId: testOrgId };

    await createPhoneEndpoint(phoneReq, phoneRes);
    testPhoneNumberId = phoneRes._body.number;
    return testPhoneNumberId;
  };

  // Helper function to create registration
  const createTestRegistration = async () => {
    const registrationReq = createMockRequest({
      body: {
        type: 'phone-registration',
        name: 'Test Registration Endpoint',
        handler: 'livekit',
        outbound: false,
        registrar: 'sip:test.example.com:5060',
        username: 'testuser',
        password: 'testpass',
        options: { region: 'us-east' }
      }
    });
    const registrationRes = createMockResponse();
    registrationRes.locals.user = { organisationId: testOrgId };

    await createPhoneEndpoint(registrationReq, registrationRes);
    testRegistrationId = registrationRes._body.id;
    return testRegistrationId;
  };

  test('should create WebRTC listener and allow join', async () => {

    // Create agent
    await createTestAgent();

    // Create WebRTC listener (no number or id specified)
    const listenerReq = createMockRequest({
      params: { agentId: testAgentId },
      body: { options: { websocket: false } }
    });
    const listenerRes = createMockResponse();

    await createListener(listenerReq, listenerRes);

    expect(listenerRes._status === 200 || listenerRes._status === null).toBe(true);
    expect(listenerRes._body).toHaveProperty('id');
    testWebRTCListenerId = listenerRes._body.id;


    // Test join endpoint - should work for WebRTC listener
    const joinReq = createMockRequest({
      params: { listenerId: testWebRTCListenerId },
      body: { options: {} }
    });
    const joinRes = createMockResponse();

    await joinListener(joinReq, joinRes);

    // Join should succeed for WebRTC listener
    expect(joinRes._status === 200 || joinRes._status === null).toBe(true);
    expect(joinRes._body).toBeDefined();

  });

  test('should create phone number listener and allow originate with phone number as caller', async () => {

    // Create agent and phone number
    await createTestAgent();
    await createTestPhoneNumber();

    // Create phone number listener
    const listenerReq = createMockRequest({
      params: { agentId: testAgentId },
      body: { number: testPhoneNumberId }
    });
    const listenerRes = createMockResponse();

    await createListener(listenerReq, listenerRes);

    expect(listenerRes._status === 200 || listenerRes._status === null).toBe(true);
    expect(listenerRes._body).toHaveProperty('id');
    testPhoneListenerId = listenerRes._body.id;


    // Test originate endpoint - should work for phone listener using phone number as caller
    const originateReq = createMockRequest({
      params: { listenerId: testPhoneListenerId },
      body: {
        calledId: '+447911123456',
        callerId: testPhoneNumberId, // Use the phone number as caller
        metadata: { test: 'data' }
      }
    });
    const originateRes = createMockResponse();
    originateRes.locals.user = { organisationId: testOrgId };

    await originateCall(originateReq, originateRes);

    // Originate should succeed for phone listener
    expect(originateRes._status === 200 || originateRes._status === null).toBe(true);
    expect(originateRes._body).toHaveProperty('success', true);
    expect(originateRes._body).toHaveProperty('data');

  });

  test('should create registration listener and allow originate with registration ID as caller', async () => {

    // Create agent and registration
    await createTestAgent();
    await createTestRegistration();

    // Create registration listener
    const listenerReq = createMockRequest({
      params: { agentId: testAgentId },
      body: { id: testRegistrationId }
    });
    const listenerRes = createMockResponse();

    await createListener(listenerReq, listenerRes);

    expect(listenerRes._status === 200 || listenerRes._status === null).toBe(true);
    expect(listenerRes._body).toHaveProperty('id');
    testRegistrationListenerId = listenerRes._body.id;


    // Test originate endpoint - should work for registration listener using registration ID as caller
    const originateReq = createMockRequest({
      params: { listenerId: testRegistrationListenerId },
      body: {
        calledId: '+447911123456',
        callerId: testRegistrationId, // Use the registration ID as caller
        metadata: { test: 'data' }
      }
    });
    const originateRes = createMockResponse();
    originateRes.locals.user = { organisationId: testOrgId };

    await originateCall(originateReq, originateRes);

    // Originate should succeed for registration listener
    expect(originateRes._status === 200 || originateRes._status === null).toBe(true);
    expect(originateRes._body).toHaveProperty('success', true);
    expect(originateRes._body).toHaveProperty('data');

  });

  test('should allow join on phone number listener (current behavior)', async () => {

    // Create agent and phone number
    await createTestAgent();
    await createTestPhoneNumber();

    // Create phone number listener
    const listenerReq = createMockRequest({
      params: { agentId: testAgentId },
      body: { number: testPhoneNumberId }
    });
    const listenerRes = createMockResponse();

    await createListener(listenerReq, listenerRes);
    testPhoneListenerId = listenerRes._body.id;

    // Test join endpoint - currently allows join on phone listener
    // NOTE: This might be a bug - join should probably be rejected for phone listeners
    const joinReq = createMockRequest({
      params: { listenerId: testPhoneListenerId },
      body: { options: {} }
    });
    const joinRes = createMockResponse();

    await joinListener(joinReq, joinRes);

    // Currently join succeeds for phone listener (might be a bug)
    expect(joinRes._status === 200 || joinRes._status === null).toBe(true);
    expect(joinRes._body).toBeDefined();

  });

  test('should allow join on registration listener (current behavior)', async () => {

    // Create agent and registration
    await createTestAgent();
    await createTestRegistration();

    // Create registration listener
    const listenerReq = createMockRequest({
      params: { agentId: testAgentId },
      body: { id: testRegistrationId }
    });
    const listenerRes = createMockResponse();

    await createListener(listenerReq, listenerRes);
    testRegistrationListenerId = listenerRes._body.id;

    // Test join endpoint - currently allows join on registration listener
    // NOTE: This might be a bug - join should probably be rejected for registration listeners
    const joinReq = createMockRequest({
      params: { listenerId: testRegistrationListenerId },
      body: { options: {} }
    });
    const joinRes = createMockResponse();

    await joinListener(joinReq, joinRes);

    // Currently join succeeds for registration listener (might be a bug)
    expect(joinRes._status === 200 || joinRes._status === null).toBe(true);
    expect(joinRes._body).toBeDefined();

  });

  test('should reject originate on WebRTC listener', async () => {

    // Create agent
    await createTestAgent();

    // Create WebRTC listener
    const listenerReq = createMockRequest({
      params: { agentId: testAgentId },
      body: { options: { websocket: false } }
    });
    const listenerRes = createMockResponse();

    await createListener(listenerReq, listenerRes);
    testWebRTCListenerId = listenerRes._body.id;

    // Test originate endpoint - should fail for WebRTC listener
    const originateReq = createMockRequest({
      params: { listenerId: testWebRTCListenerId },
      body: {
        calledId: '+447911123456',
        callerId: testPhoneNumberId,
        metadata: { test: 'data' }
      }
    });
    const originateRes = createMockResponse();
    originateRes.locals.user = { organisationId: testOrgId };

    await originateCall(originateReq, originateRes);

    // Originate should fail for WebRTC listener (no phone number associated)
    expect(originateRes._status).toBe(500);
    expect(originateRes._body).toHaveProperty('error');

  });

  test('should validate originate parameters', async () => {

    // Create agent and phone number
    await createTestAgent();
    await createTestPhoneNumber();

    // Create phone listener
    const listenerReq = createMockRequest({
      params: { agentId: testAgentId },
      body: { number: testPhoneNumberId }
    });
    const listenerRes = createMockResponse();

    await createListener(listenerReq, listenerRes);
    testPhoneListenerId = listenerRes._body.id;

    // Test missing calledId
    const originateReq1 = createMockRequest({
      params: { listenerId: testPhoneListenerId },
      body: {
        callerId: testPhoneNumberId
        // missing calledId
      }
    });
    const originateRes1 = createMockResponse();
    originateRes1.locals.user = { organisationId: testOrgId };

    await originateCall(originateReq1, originateRes1);

    expect(originateRes1._status).toBe(400);
    expect(originateRes1._body).toHaveProperty('error');
    expect(originateRes1._body.error).toContain('Missing required parameters');

    // Test missing callerId
    const originateReq2 = createMockRequest({
      params: { listenerId: testPhoneListenerId },
      body: {
        calledId: '+447911123456'
        // missing callerId
      }
    });
    const originateRes2 = createMockResponse();
    originateRes2.locals.user = { organisationId: testOrgId };

    await originateCall(originateReq2, originateRes2);

    expect(originateRes2._status).toBe(400);
    expect(originateRes2._body).toHaveProperty('error');
    expect(originateRes2._body.error).toContain('Missing required parameters');

  });

  test('should validate UK phone number format', async () => {

    // Create agent and phone number
    await createTestAgent();
    await createTestPhoneNumber();

    // Create phone listener
    const listenerReq = createMockRequest({
      params: { agentId: testAgentId },
      body: { number: testPhoneNumberId }
    });
    const listenerRes = createMockResponse();

    await createListener(listenerReq, listenerRes);
    testPhoneListenerId = listenerRes._body.id;

    // Test invalid UK number
    const originateReq = createMockRequest({
      params: { listenerId: testPhoneListenerId },
      body: {
        calledId: '+1234567890', // Invalid UK number
        callerId: testPhoneNumberId
      }
    });
    const originateRes = createMockResponse();
    originateRes.locals.user = { organisationId: testOrgId };

    await originateCall(originateReq, originateRes);

    expect(originateRes._status).toBe(400);
    expect(originateRes._body).toHaveProperty('error');
    expect(originateRes._body.error).toContain('not a valid UK geographic or mobile number');

  });
});
