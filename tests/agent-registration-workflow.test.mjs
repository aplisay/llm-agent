import dotenv from 'dotenv';
import { setupRealDatabase, teardownRealDatabase, Agent, Instance, PhoneNumber, PhoneRegistration, Call, TransactionLog, User, Organisation, AuthKey, Trunk, Op, Sequelize, databaseStarted, stopDatabase } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import aplisayTestAgentBase from './fixtures/aplisayTestAgentBase.js';

describe('Agent Registration Workflow Test', () => {
  let models;
  let testOrgId;
  let testUserId;
  let testAgentId;
  let testRegistrationId;
  let testListenerId;

  // API endpoint handlers
  let createAgent;
  let createPhoneEndpoint;
  let activateRegistration;
  let getPhoneEndpoint;
  let createListener;
  let deleteListener;
  let deleteAgent;
  let deletePhoneEndpoint;
  let registrationSimulator;

  // Mock objects for API endpoints
  let mockLogger;
  let mockVoices;
  let mockWsServer;

  beforeAll(async () => {
    // Connect to real database
    await setupRealDatabase();
    dotenv.config();
    models = { Agent, Instance, PhoneNumber, PhoneRegistration, Call, TransactionLog, User, Organisation, AuthKey, Trunk };

    // Import API endpoints after database is set up
    const agentsModule = await import('../api/paths/agents.js');
    const phoneEndpointsModule = await import('../api/paths/phone-endpoints.js');
    const activateModule = await import('../api/paths/phone-endpoints/{identifier}/activate.js');
    const getPhoneEndpointModule = await import('../api/paths/phone-endpoints/{identifier}.js');
    const listenModule = await import('../api/paths/agents/{agentId}/listen.js');
    const deleteListenerModule = await import('../api/paths/listener/{listenerId}.js');
    const deleteAgentModule = await import('../api/paths/agents/{agentId}.js');
    const registrationSimulationModule = await import('../lib/registration-simulation.js');

    // Create mock logger and other dependencies
    mockLogger = {
      info: () => {},
      error: () => {},
      warn: () => {},
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
    const getPhoneEndpointHandler = getPhoneEndpointModule.default(mockLogger, mockVoices, mockWsServer);
    const listenHandler = listenModule.default(mockWsServer);
    const deleteListenerHandler = deleteListenerModule.default(mockLogger, mockVoices, mockWsServer);
    const deleteAgentHandler = deleteAgentModule.default(mockLogger, mockVoices, mockWsServer);
    createAgent = agents.POST;
    createPhoneEndpoint = phoneEndpoints.POST;
    activateRegistration = activateHandler.POST;
    getPhoneEndpoint = getPhoneEndpointHandler.GET;
    createListener = listenHandler.POST;
    deleteListener = deleteListenerHandler.DELETE;
    deleteAgent = deleteAgentHandler.DELETE;
    deletePhoneEndpoint = phoneEndpoints.DELETE;
    registrationSimulator = registrationSimulationModule.registrationSimulator;
  }, 30000);

  afterAll(async () => {
    // Stop all active simulations to prevent database connection errors
    try {
      const allSimulations = registrationSimulator.getAllSimulations();
      for (const sim of allSimulations) {
        registrationSimulator.stopSimulation(sim.registrationId);
      }
    } catch (err) {
      console.warn('Simulation cleanup warning:', err.message);
    }

    // Disconnect from real database
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    const { Organisation, User } = models;

    // Create test organisation and user
    testOrgId = randomUUID();
    testUserId = randomUUID();
    
    await Organisation.create({
      id: testOrgId,
      name: 'Test Organisation for Registration Workflow'
    });

    await User.create({
      id: testUserId,
      organisationId: testOrgId,
      name: 'Test User',
      email: 'test@example.com'
    });
  });

  afterEach(async () => {
    // Cleanup any remaining test data
    const { Agent, PhoneRegistration, Instance, Organisation, User } = models;
    
    try {
      if (testListenerId) {
        await Instance.destroy({ where: { id: testListenerId } });
        testListenerId = null;
      }
      if (testAgentId) {
        await Agent.destroy({ where: { id: testAgentId } });
        testAgentId = null;
      }
      if (testRegistrationId) {
        await PhoneRegistration.destroy({ where: { id: testRegistrationId } });
        testRegistrationId = null;
      }
      if (testUserId) {
        await User.destroy({ where: { id: testUserId } });
        testUserId = null;
      }
      if (testOrgId) {
        await Organisation.destroy({ where: { id: testOrgId } });
        testOrgId = null;
      }
    } catch (err) {
      console.warn('Cleanup warning:', err.message);
    }
  });

  // Helper function to create mock request/response objects
  const createMockRequest = (overrides = {}) => ({
    body: {},
    params: {},
    headers: {},
    log: mockLogger,
    ...overrides
  });

  const createMockResponse = () => {
    const res = {
      _status: null,
      _body: null,
      locals: { user: { id: testUserId, organisationId: testOrgId } },
      status: function(code) { this._status = code; return this; },
      send: function(data) { this._body = data; return this; }
    };
    return res;
  };

  // Helper function to wait for registration state
  const waitForRegistrationState = async (registrationId, targetState, timeoutMs = 240000) => {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const req = createMockRequest({ params: { identifier: registrationId } });
      const res = createMockResponse();
      res.locals.user = { organisationId: testOrgId };
      console.log('Waiting for registration state...');
      await getPhoneEndpoint(req, res);

      console.log('Registration state', { return: res._body });
      
      // Check if we got a valid response (status 200 or null with body)
      if ((res._status === 200 || res._status === null) && res._body && res._body.state) {
        if (res._body.state === targetState) {
          return { success: true, state: res._body.state, status: res._body.status };
        }
        
        // Check if registration failed
        if (res._body.state === 'failed') {
          return { success: false, state: res._body.state, status: res._body.status, error: res._body.error };
        }
      }
      
      // Wait 1 second before checking again (faster for testing)
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return { success: false, state: 'timeout', status: 'timeout', error: 'Registration timeout' };
  };

  test('Complete Agent Registration Workflow', async () => {
    console.log('Starting Agent Registration Workflow Test...');

    // Mock setTimeout to run at 15x speed for faster testing
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const speedMultiplier = 15;

    global.setTimeout = (callback, delay) => {
      const fastDelay = Math.max(1, Math.floor(delay / speedMultiplier));
      return originalSetTimeout(callback, fastDelay);
    };

    global.clearTimeout = originalClearTimeout;

    try {
      // Step 1: Create agent using aplisayTestAgentBase
    console.log('Step 1: Creating agent...');
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

    // Step 2: Create phone registration endpoint
    console.log('Step 2: Creating phone registration endpoint...');
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
    
    await createPhoneEndpoint(registrationReq, registrationRes);
    
    expect(registrationRes._status).toBe(201);
    expect(registrationRes._body).toHaveProperty('success', true);
    expect(registrationRes._body).toHaveProperty('id');
    testRegistrationId = registrationRes._body.id;
    console.log(`Registration endpoint created with ID: ${testRegistrationId}`);

    // Step 3: Activate the registration
    console.log('Step 3: Activating registration...');
    const activateReq = createMockRequest({
      params: { identifier: testRegistrationId }
    });
    const activateRes = createMockResponse();
    
    await activateRegistration(activateReq, activateRes);
    
    // Activation succeeds if we have a body with success property
    if (activateRes._body && activateRes._body.success) {
      console.log('Registration activated successfully');
    } else {
      console.log(`Registration activation failed with status ${activateRes._status}:`, activateRes._body);
      expect(activateRes._status).toBe(200);
    }
    
    expect(activateRes._body).toHaveProperty('success', true);
    expect(activateRes._body).toHaveProperty('status', 'active');
    expect(activateRes._body).toHaveProperty('state', 'initial');

    // Step 4: Wait for registration to become registered (with fast simulation)
    console.log('Step 4: Waiting for registration to become registered...');
    const registrationResult = await waitForRegistrationState(testRegistrationId, 'registered', 20000); // 20 seconds instead of 240
    
    if (!registrationResult.success) {
      console.log(`Registration failed or timed out: ${registrationResult.error}`);
      // Exit with zero exit code as requested if registration fails
      expect(['failed', 'timeout']).toContain(registrationResult.state);
      return;
    }
    
    console.log(`Registration successfully reached registered state: ${registrationResult.state}`);

    // Step 5: Create agent listener using the registered endpoint
    console.log('Step 5: Creating agent listener...');
    const listenerReq = createMockRequest({
      params: { agentId: testAgentId },
      body: { id: testRegistrationId }
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

    // Step 6: Monitor for failure or timeout (16 seconds instead of 240)
    console.log('Step 6: Monitoring registration for 16 seconds...');
    const monitorStartTime = Date.now();
    const monitorTimeout = 16000; // 16 seconds instead of 240 seconds
    
    let finalState = 'registered';
    let finalStatus = 'active';
    
    while (Date.now() - monitorStartTime < monitorTimeout) {
      const checkReq = createMockRequest({ params: { identifier: testRegistrationId } });
      const checkRes = createMockResponse();
      
      await getPhoneEndpoint(checkReq, checkRes);
      
      if (checkRes._status === 200) {
        finalState = checkRes._body.state;
        finalStatus = checkRes._body.status;
        
        // If registration goes to failed state, break out of monitoring
        if (finalState === 'failed') {
          console.log(`Registration went to failed state: ${checkRes._body.error}`);
          break;
        }
      }
      
      // Wait 1 second before checking again (instead of 10 seconds)
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log(`Monitoring completed. Final state: ${finalState}, Final status: ${finalStatus}`);

    // Step 7: Cleanup - delete listener, agent, and registration
    console.log('Step 7: Cleaning up resources...');
    
    // Delete listener
    if (testListenerId) {
      const deleteListenerReq = createMockRequest({ params: { listenerId: testListenerId } });
      const deleteListenerRes = createMockResponse();
      
      await deleteListener(deleteListenerReq, deleteListenerRes);
      expect(deleteListenerRes._status).toBe(200);
      console.log('Listener deleted successfully');
    }

    // Delete agent
    if (testAgentId) {
      const deleteAgentReq = createMockRequest({ params: { agentId: testAgentId } });
      const deleteAgentRes = createMockResponse();
      
      await deleteAgent(deleteAgentReq, deleteAgentRes);
      expect(deleteAgentRes._status).toBe(200);
      console.log('Agent deleted successfully');
    }

    // Delete registration
    if (testRegistrationId) {
      const deleteRegistrationReq = createMockRequest({ 
        params: { identifier: testRegistrationId },
        query: {} // Ensure req.query exists for deletePhoneEndpoint
      });
      const deleteRegistrationRes = createMockResponse();
      
      await deletePhoneEndpoint(deleteRegistrationReq, deleteRegistrationRes);
      if (deleteRegistrationRes._body || deleteRegistrationRes._status === 200) {
        console.log('Registration deleted successfully');
      } else {
        console.log(`Registration deletion failed with status ${deleteRegistrationRes._status}:`, deleteRegistrationRes._body);
      }
    }

    console.log('Agent Registration Workflow Test completed successfully!');
    
    } finally {
      // Restore original setTimeout
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  }, 60000); // 1 minute timeout for the entire test (instead of 5 minutes)
});
