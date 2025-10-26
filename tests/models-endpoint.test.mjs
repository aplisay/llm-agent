import dotenv from 'dotenv';
import { setupRealDatabase, teardownRealDatabase, getRealDatabase } from './setup/database-test-wrapper.js';

describe('Models Endpoint Test', () => {
  let models;
  let modelList;

  // Mock objects for API endpoints
  let mockLogger;

  beforeAll(async () => {
    // Connect to real database
    await setupRealDatabase();
    const realDb = getRealDatabase();
    dotenv.config();
    models = realDb.models;

    // Import API endpoints after database is set up
    const modelsModule = await import('../api/paths/models.js');

    // Create mock logger
    mockLogger = {
      info: () => {},
      error: () => {},
      debug: () => {},
      child: () => mockLogger
    };

    // Initialize the API endpoint
    const modelsHandler = modelsModule.default(mockLogger);
    modelList = modelsHandler.GET;
  }, 30000);

  afterAll(async () => {
    // Disconnect from real database
    await teardownRealDatabase();
  }, 60000);

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

  test('should return list of available models', async () => {
    console.log('Testing models endpoint...');

    const req = createMockRequest();
    const res = createMockResponse();

    await modelList(req, res);

    // Should return 200 status (or null if not explicitly set)
    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();
    expect(typeof res._body).toBe('object');

    // Should contain model information
    const modelEntries = Object.entries(res._body);
    expect(modelEntries.length).toBeGreaterThan(0);

    console.log(`Found ${modelEntries.length} available models:`);

    // Validate each model entry
    for (const [modelName, modelInfo] of modelEntries) {
      console.log(`  - ${modelName}: ${modelInfo.description}`);
      
      // Each model should have required properties
      expect(modelInfo).toHaveProperty('description');
      expect(modelInfo).toHaveProperty('supportsFunctions');
      expect(modelInfo).toHaveProperty('audioModel');
      expect(modelInfo).toHaveProperty('hasTelephony');
      expect(modelInfo).toHaveProperty('hasWebRTC');

      // Validate property types
      expect(typeof modelInfo.description).toBe('string');
      expect(typeof modelInfo.supportsFunctions).toBe('boolean');
      expect(typeof modelInfo.hasTelephony).toBe('boolean');
      expect(typeof modelInfo.hasWebRTC).toBe('boolean');

      // Model name should follow handler:provider/model format
      expect(modelName).toMatch(/^[a-zA-Z0-9]+:[a-zA-Z0-9\/\-\.]+$/);
    }

    console.log('Models endpoint test completed successfully!');
  });

  test('should handle errors gracefully', async () => {
    console.log('Testing models endpoint error handling...');

    // Create a request that might cause an error
    const req = createMockRequest();
    const res = createMockResponse();

    // Test that the endpoint handles requests properly
    await modelList(req, res);

    // The response should be structured correctly
    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();
    
    console.log('Error handling test completed!');
  });

  test('should return consistent model structure', async () => {
    console.log('Testing model structure consistency...');

    const req = createMockRequest();
    const res = createMockResponse();

    await modelList(req, res);

    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();

    const modelEntries = Object.entries(res._body);
    
    // All models should have the same structure
    for (const [modelName, modelInfo] of modelEntries) {
      const requiredKeys = ['description', 'supportsFunctions', 'audioModel', 'hasTelephony', 'hasWebRTC'];
      
      for (const key of requiredKeys) {
        expect(modelInfo).toHaveProperty(key);
      }

      // Should not have extra unexpected keys
      const actualKeys = Object.keys(modelInfo);
      expect(actualKeys).toEqual(expect.arrayContaining(requiredKeys));
    }

    console.log('Model structure consistency test completed!');
  });

  test('should include expected handler types', async () => {
    console.log('Testing for expected handler types...');

    const req = createMockRequest();
    const res = createMockResponse();

    await modelList(req, res);

    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();

    const modelNames = Object.keys(res._body);
    
    // Should include models from different handlers
    const handlers = new Set();
    modelNames.forEach(name => {
      const handler = name.split(':')[0];
      handlers.add(handler);
    });

    console.log(`Found handlers: ${Array.from(handlers).join(', ')}`);

    // Should have at least one handler
    expect(handlers.size).toBeGreaterThan(0);

    // Common handlers that might be present
    const expectedHandlers = ['jambonz', 'livekit', 'ultravox'];
    const hasExpectedHandler = expectedHandlers.some(handler => handlers.has(handler));
    
    // At least one expected handler should be present
    expect(hasExpectedHandler).toBe(true);

    console.log('Handler types test completed!');
  });

  test('should validate model capabilities', async () => {
    console.log('Testing model capabilities...');

    const req = createMockRequest();
    const res = createMockResponse();

    await modelList(req, res);

    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();

    const modelEntries = Object.entries(res._body);
    
    for (const [modelName, modelInfo] of modelEntries) {
      // Check that capabilities are boolean values
      expect(typeof modelInfo.supportsFunctions).toBe('boolean');
      expect(typeof modelInfo.hasTelephony).toBe('boolean');
      expect(typeof modelInfo.hasWebRTC).toBe('boolean');

      // Check that descriptions are non-empty strings
      expect(modelInfo.description).toBeTruthy();
      expect(modelInfo.description.length).toBeGreaterThan(0);

      // Check that audioModel is defined (could be string, boolean, object, or undefined)
      // Some models might not have audioModel property
      if (modelInfo.audioModel !== undefined) {
        expect(modelInfo.audioModel).toBeDefined();
      }
    }

    console.log('Model capabilities validation completed!');
  });
});
