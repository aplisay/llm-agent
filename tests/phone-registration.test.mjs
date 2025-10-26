import { setupRealDatabase, teardownRealDatabase, Agent, Instance, PhoneNumber, PhoneRegistration, Call, TransactionLog, User, Organisation, AuthKey, Trunk, Op, Sequelize, databaseStarted, stopDatabase } from './setup/database-test-wrapper.js';

describe('PhoneRegistration Basic Tests', () => {
  let models;
  let mockLogger;
  let mockVoices;
  let mockWsServer;
  let createPhoneEndpoint;
  let testOrgId;

  beforeAll(async () => {
    // Ensure a credentials key is present for encryption tests
    process.env.CREDENTIALS_KEY = process.env.CREDENTIALS_KEY || 'test-secret-key';
    process.env.DB_FORCE_SYNC = 'true';
    
    // Connect to real database
    await setupRealDatabase();
    await databaseStarted;
    models = { Agent, Instance, PhoneNumber, PhoneRegistration, Call, TransactionLog, User, Organisation, AuthKey, Trunk };

    // Import API endpoints after database is set up
    const phoneEndpointsModule = await import('../api/paths/phone-endpoints.js');

    // Create mock logger and other dependencies
    mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => mockLogger
    };
    mockVoices = {};
    mockWsServer = {
      emit: () => {},
      on: () => {},
      off: () => {}
    };

    // Initialize the API endpoint
    const phoneEndpoints = phoneEndpointsModule.default(mockLogger, mockVoices, mockWsServer);
    createPhoneEndpoint = phoneEndpoints.POST;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    // Create a fresh test organisation for each test to ensure isolation
    const testOrg = await Organisation.create({
      id: 'org-test-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      name: 'Test Organisation'
    });
    testOrgId = testOrg.id;
  });

  afterEach(async () => {
    // Clean up test data to prevent interference between tests
    if (testOrgId) {
      try {
        await PhoneRegistration.destroy({ where: { organisationId: testOrgId } });
        await Organisation.destroy({ where: { id: testOrgId } });
      } catch (error) {
        // Ignore cleanup errors to prevent test failures
      }
    }
  });

  test('Model: creates and stores encrypted password at rest', async () => {
    let created;
    try {
      created = await PhoneRegistration.create({
        name: 'SIP Reg Test',
        registrar: 'sip:provider.example.com:5060',
        username: 'user123',
        password: 'super-secret',
        outbound: true,
        handler: 'livekit',
        options: { region: 'eu-west' },
        organisationId: testOrgId
      });

      expect(created.id).toBeTruthy();

      // Getter returns plaintext
      expect(created.password).toBe('super-secret');

      // Raw stored value should be encrypted (prefixed marker)
      const raw = created.getDataValue('password');
      if (process.env.CREDENTIALS_KEY) {
        expect(typeof raw).toBe('string');
        expect(raw.startsWith('enc:')).toBe(true);
      } else {
        // Fallback: plaintext when key missing
        expect(raw).toBe('super-secret');
      }
    } catch (error) {
      console.error('Test failed with error:', error);
      throw error;
    } finally {
      // Clean up
      if (created) {
        await created.destroy();
      }
    }
  });

  test('API: POST /api/phone-endpoints persists registration and encrypts password', async () => {
    const req = {
      body: {
        type: 'phone-registration',
        name: 'Via API',
        registrar: 'sip:provider.example.com:5060',
        username: 'api-user',
        password: 'api-secret',
        outbound: false,
        handler: 'livekit',
        options: { impl: 'test' }
      },
      log: mockLogger
    };
    const res = {
      locals: { user: { organisationId: testOrgId } },
      _status: null,
      _body: null,
      status(code) { this._status = code; return this; },
      send(body) { this._body = body; this._status = this._status || 200; }
    };

    try {
      await createPhoneEndpoint(req, res);

      expect(res._status).toBe(201);
      expect(res._body?.success).toBe(true);
      expect(res._body?.id).toBeTruthy();

      // Verify it was persisted and password is encrypted at rest
      const persisted = await PhoneRegistration.findByPk(res._body.id);
      expect(persisted).toBeTruthy();
      expect(persisted.username).toBe('api-user');
      expect(persisted.password).toBe('api-secret'); // getter returns plaintext
      const raw = persisted.getDataValue('password');
      if (process.env.CREDENTIALS_KEY) {
        expect(raw.startsWith('enc:')).toBe(true);
      }

      // Clean up
      await persisted.destroy();
    } catch (error) {
      // If test fails, still clean up the organisation
      console.error('Test failed with error:', error);
      throw error;
    }
  });
});
