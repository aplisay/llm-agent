import 'dotenv/config';

import { setupRealDatabase, teardownRealDatabase, Agent, Instance, PhoneNumber, PhoneRegistration, Call, TransactionLog, User, Organisation, AuthKey, Trunk, Op, Sequelize, databaseStarted, stopDatabase } from './setup/database-test-wrapper.js';

describe('PhoneRegistration Basic Tests', () => {

  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  beforeAll(async () => {
    // Ensure a credentials key is present for encryption tests
    process.env.CREDENTIALS_KEY = process.env.CREDENTIALS_KEY || 'test-secret-key';
    process.env.DB_FORCE_SYNC = 'true';
    await setupRealDatabase();
    await databaseStarted;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  test('Model: creates and stores encrypted password at rest', async () => {
    // Create a test organisation first
    const testOrg = await Organisation.create({
      id: 'org-test-' + Date.now(),
      name: 'Test Organisation'
    });

    const created = await PhoneRegistration.create({
      name: 'SIP Reg Test',
      registrar: 'sip:provider.example.com:5060',
      username: 'user123',
      password: 'super-secret',
      outbound: true,
      handler: 'livekit',
      options: { region: 'eu-west' },
      organisationId: testOrg.id
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

    // Clean up
    await created.destroy();
    await testOrg.destroy();
  });

  test('API: POST /api/phone-endpoints persists registration and encrypts password', async () => {
    // Create a test organisation first
    const testOrg = await Organisation.create({
      id: 'org-api-' + Date.now(),
      name: 'API Test Organisation'
    });

    const { default: factory } = await import('../api/paths/phone-endpoints.js');
    const path = factory(logger, null, null);
    const handler = path.POST;

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
      log: logger
    };
    const res = {
      locals: { user: { organisationId: testOrg.id } },
      _status: null,
      _body: null,
      status(code) { this._status = code; return this; },
      send(body) { this._body = body; this._status = this._status || 200; }
    };

    await handler(req, res);

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
    await testOrg.destroy();
  });
});
