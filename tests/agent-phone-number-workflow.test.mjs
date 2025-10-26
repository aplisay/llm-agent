import dotenv from 'dotenv';
import { setupRealDatabase, teardownRealDatabase, getRealDatabase } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import aplisayTestAgentBase from './fixtures/aplisayTestAgentBase.js';

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
    const realDb = getRealDatabase();
    dotenv.config();
    models = realDb.models;

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
    deletePhoneEndpoint = phoneEndpoints.DELETE;
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
    console.log('Starting Agent Phone Number Workflow Test...');

    try {
      // Step 1: Create phone number endpoint
      console.log('Step 1: Creating phone number endpoint...');
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
        console.log(`Phone number created: ${testPhoneNumberId}`);
      } else {
        console.log(`Phone number creation failed with status ${phoneRes._status}:`, phoneRes._body);
        expect(phoneRes._status).toBe(201);
      }

      expect(phoneRes._body).toHaveProperty('success', true);
      expect(phoneRes._body).toHaveProperty('number');

      // Step 2: Create agent using aplisayTestAgentBase
      console.log('Step 2: Creating agent...');
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
        console.log(`Agent created with ID: ${testAgentId}`);
      } else {
        console.log(`Agent creation failed with status ${agentRes._status}:`, agentRes._body);
        expect(agentRes._status).toBe(200);
      }

      expect(agentRes._body).toHaveProperty('id');

      // Step 3: Create agent listener using the phone number
      console.log('Step 3: Creating agent listener...');
      const listenerReq = createMockRequest({
        params: { agentId: testAgentId },
        body: { number: testPhoneNumberId }
      });
      const listenerRes = createMockResponse();
      
      await createListener(listenerReq, listenerRes);
      
      // Listener creation succeeds if we have a body with an id
      if (listenerRes._body && listenerRes._body.id) {
        testListenerId = listenerRes._body.id;
        console.log(`Agent listener created with ID: ${testListenerId}`);
      } else {
        console.log(`Agent listener creation failed with status ${listenerRes._status}:`, listenerRes._body);
        expect(listenerRes._status).toBe(200);
      }
      
      expect(listenerRes._body).toHaveProperty('id');

      // Step 4: Delete the listener
      console.log('Step 4: Deleting agent listener...');
      const deleteListenerReq = createMockRequest({
        params: { listenerId: testListenerId }
      });
      const deleteListenerRes = createMockResponse();

      await deleteListener(deleteListenerReq, deleteListenerRes);

      if (deleteListenerRes._body || deleteListenerRes._status === 200) {
        console.log('Listener deleted successfully');
      } else {
        console.log(`Listener deletion failed with status ${deleteListenerRes._status}:`, deleteListenerRes._body);
        expect(deleteListenerRes._status).toBe(200);
      }

      // Step 5: Delete the agent
      console.log('Step 5: Deleting agent...');
      const deleteAgentReq = createMockRequest({
        params: { agentId: testAgentId }
      });
      const deleteAgentRes = createMockResponse();
      deleteAgentRes.locals.user = { id: testUserId, organisationId: testOrgId };

      await deleteAgent(deleteAgentReq, deleteAgentRes);

      if (deleteAgentRes._body || deleteAgentRes._status === 200) {
        console.log('Agent deleted successfully');
      } else {
        console.log(`Agent deletion failed with status ${deleteAgentRes._status}:`, deleteAgentRes._body);
        expect(deleteAgentRes._status).toBe(200);
      }

      // Step 6: Delete the phone number
      console.log('Step 6: Deleting phone number...');
      const deletePhoneReq = createMockRequest({
        params: { identifier: testPhoneNumberId }
      });
      const deletePhoneRes = createMockResponse();
      deletePhoneRes.locals.user = { organisationId: testOrgId };

      await deletePhoneEndpoint(deletePhoneReq, deletePhoneRes);

      if (deletePhoneRes._body || deletePhoneRes._status === 200) {
        console.log('Phone number deleted successfully');
      } else {
        console.log(`Phone number deletion failed with status ${deletePhoneRes._status}:`, deletePhoneRes._body);
        expect(deletePhoneRes._status).toBe(200);
      }

      console.log('Agent Phone Number Workflow Test completed successfully!');
      
    } catch (error) {
      console.error('Test failed with error:', error);
      throw error;
    }
  }, 60000); // 1 minute timeout for the entire test
});
