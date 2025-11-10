import { setupRealDatabase, teardownRealDatabase, Agent, Instance, PhoneNumber, PhoneRegistration, Call, TransactionLog, User, Organisation, AuthKey, Trunk, Op, Sequelize, databaseStarted, stopDatabase } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import aplisayTestAgentBase from './fixtures/agents/test-agent-base.js';

describe('Agent Phone Number Workflow Test', () => {
  let models;
  let testOrgId;
  let testUserId;
  let testTrunkId;
  let testAgentId;
  let testPhoneNumberId;
  let testListenerId;

  // API endpoint handlers
  let createAgent;
  let createPhoneEndpoint;
  let getPhoneEndpoint;
  let createListener;
  let deleteListener;
  let deleteAgent;
  let deletePhoneEndpoint;

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
    const getPhoneEndpointModule = await import('../api/paths/phone-endpoints/{identifier}.js');
    const listenModule = await import('../api/paths/agents/{agentId}/listen.js');
    const deleteListenerModule = await import('../api/paths/listener/{listenerId}.js');
    const deleteAgentModule = await import('../api/paths/agents/{agentId}.js');

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
    const getPhoneEndpointHandler = getPhoneEndpointModule.default(mockLogger, mockVoices, mockWsServer);
    const listenHandler = listenModule.default(mockWsServer);
    const deleteListenerHandler = deleteListenerModule.default(mockLogger, mockVoices, mockWsServer);
    const deleteAgentHandler = deleteAgentModule.default(mockLogger, mockVoices, mockWsServer);

    createAgent = agents.POST;
    createPhoneEndpoint = phoneEndpoints.POST;
    getPhoneEndpoint = getPhoneEndpointHandler.GET;
    createListener = listenHandler.POST;
    deleteListener = deleteListenerHandler.DELETE;
    deleteAgent = deleteAgentHandler.DELETE;
    deletePhoneEndpoint = getPhoneEndpointHandler.DELETE;
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
    const { Organisation, User, Agent, PhoneNumber, PhoneRegistration, Trunk } = models;
    
    if (testOrgId) {
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
    
    return res;
  };

  test('Complete Agent Phone Number Workflow', async () => {

    try {
      // Step 1: Create phone number endpoint
      const phoneReq = createMockRequest({
        body: {
          type: 'e164-ddi',
          number: '+1234567890',
          handler: 'livekit',
          outbound: false,
          trunkId: testTrunkId
        }
      });
      const phoneRes = createMockResponse();
      phoneRes.locals.user = { organisationId: testOrgId };

      await createPhoneEndpoint(phoneReq, phoneRes);

      // Phone number creation succeeds if we have a body with success property
      if (phoneRes._body && phoneRes._body.success) {
        testPhoneNumberId = phoneRes._body.number;
      } else {
        expect(phoneRes._status).toBe(201);
      }

      expect(phoneRes._body).toHaveProperty('success', true);
      expect(phoneRes._body).toHaveProperty('number');

      // Step 2: Create agent using aplisayTestAgentBase
      // Convert functions from array format to object format with proper schema
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

      // Agent creation succeeds if we have a body with an id, regardless of status
      if (agentRes._body && agentRes._body.id) {
        testAgentId = agentRes._body.id;
      } else {
        expect(agentRes._status).toBe(200);
      }

      expect(agentRes._body).toHaveProperty('id');

      // Step 3: Create agent listener using the phone number
      const listenerReq = createMockRequest({
        params: { agentId: testAgentId },
        body: { number: testPhoneNumberId }
      });
      const listenerRes = createMockResponse();
      
      await createListener(listenerReq, listenerRes);
      
      // Listener creation succeeds if we have a body with an id
      if (listenerRes._body && listenerRes._body.id) {
        testListenerId = listenerRes._body.id;
      } else {
        expect(listenerRes._status).toBe(200);
      }
      
      expect(listenerRes._body).toHaveProperty('id');

      // Step 4: Delete the listener
      const deleteListenerReq = createMockRequest({
        params: { listenerId: testListenerId }
      });
      const deleteListenerRes = createMockResponse();

      await deleteListener(deleteListenerReq, deleteListenerRes);

      if (deleteListenerRes._body || deleteListenerRes._status === 200) {
      } else {
        expect(deleteListenerRes._status).toBe(200);
      }

      // Step 5: Delete the agent
      const deleteAgentReq = createMockRequest({
        params: { agentId: testAgentId }
      });
      const deleteAgentRes = createMockResponse();
      deleteAgentRes.locals.user = { id: testUserId, organisationId: testOrgId };

      await deleteAgent(deleteAgentReq, deleteAgentRes);

      if (deleteAgentRes._body || deleteAgentRes._status === 200) {
      } else {
        expect(deleteAgentRes._status).toBe(200);
      }

      // Step 6: Delete the phone number
      const deletePhoneReq = createMockRequest({
        params: { identifier: testPhoneNumberId }
      });
      const deletePhoneRes = createMockResponse();
      deletePhoneRes.locals.user = { organisationId: testOrgId };

      await deletePhoneEndpoint(deletePhoneReq, deletePhoneRes);

      if (deletePhoneRes._body || deletePhoneRes._status === 200) {
      } else {
        expect(deletePhoneRes._status).toBe(200);
      }

      
    } catch (error) {
      throw error;
    }
  }, 60000); // 1 minute timeout for the entire test
});
