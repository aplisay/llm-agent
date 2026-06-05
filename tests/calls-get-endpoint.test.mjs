import {
  setupRealDatabase,
  databaseStarted,
  teardownRealDatabase,
  Call,
  Organisation,
  User
} from './setup/database-test-wrapper.js';
import { scopeWhereForUser } from '../lib/scope.js';

describe('GET /calls/{callId} Endpoint Test', () => {
  let getCall;
  let mockLogger;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    const callModule = await import('../api/paths/calls/{callId}.js');

    mockLogger = {
      info: () => { },
      error: () => { },
      debug: () => { },
      child: () => mockLogger
    };

    const callHandler = callModule.default(mockLogger);
    getCall = callHandler.GET;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  const createMockRequest = (options = {}) => ({
    body: {},
    params: {},
    query: {},
    headers: {},
    log: mockLogger,
    ...options
  });

  // Build a mock response whose locals.user is scoped to the given org/user,
  // mirroring what the auth middleware attaches (`user.sql.where`).
  const createMockResponse = (user = { id: 'test-user-id', organisationId: 'test-org-id' }) => {
    const res = {
      _status: null,
      _body: null,
      locals: {
        user: { ...user, sql: { where: scopeWhereForUser(user) } }
      }
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

  const seedCall = async () => {
    await Organisation.upsert({ id: 'test-org-id', name: 'Test Org' });
    await User.upsert({
      id: 'test-user-id',
      name: 'Test User',
      email: 'test@example.com',
      emailVerified: true,
      phone: '0000',
      phoneVerified: false,
      picture: '',
      role: { admin: true }
    });

    // hooks: false and an explicit index avoids the custom beforeCreate logic
    // interfering while still hitting the real database.
    return Call.create({
      organisationId: 'test-org-id',
      userId: 'test-user-id',
      index: 1,
      parentId: null,
      modelName: 'livekit:ultravox:ultravox-70b',
      calledId: '+442080996945',
      callerId: '+443300889471',
      status: 'ended normally',
      platform: 'test',
      platformCallId: 'pcall-get-1',
      encryptionKey: 'super-secret-key',
      metadata: { secret: true },
      options: { foo: 'bar' }
    }, { hooks: false });
  };

  test('returns the documented attributes for a single call', async () => {
    const call = await seedCall();

    const req = createMockRequest({ params: { callId: call.id } });
    const res = createMockResponse();

    await getCall(req, res);

    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();
    expect(res._body.id).toBe(call.id);

    // Exactly the attributes the handler selects (matches the OpenAPI Call schema).
    const expectedKeys = [
      'id', 'index', 'agentId', 'parentId', 'modelName',
      'callerId', 'calledId', 'startedAt', 'endedAt', 'status', 'recordingId'
    ].sort();
    expect(Object.keys(res._body).sort()).toEqual(expectedKeys);

    expect(res._body).toHaveProperty('parentId', null);
    expect(res._body).toHaveProperty('modelName', 'livekit:ultravox:ultravox-70b');
    expect(res._body).toHaveProperty('callerId', '+443300889471');
    expect(res._body).toHaveProperty('status', 'ended normally');
  });

  test('does not leak sensitive or undocumented fields', async () => {
    const call = await seedCall();

    const req = createMockRequest({ params: { callId: call.id } });
    const res = createMockResponse();

    await getCall(req, res);

    expect(res._body).not.toHaveProperty('encryptionKey');
    expect(res._body).not.toHaveProperty('metadata');
    expect(res._body).not.toHaveProperty('options');
    expect(res._body).not.toHaveProperty('platform');
    expect(res._body).not.toHaveProperty('platformCallId');
  });

  test('returns 404 for an unknown call id', async () => {
    const req = createMockRequest({ params: { callId: '00000000-0000-0000-0000-000000000000' } });
    const res = createMockResponse();

    await getCall(req, res);

    expect(res._status).toBe(404);
    expect(res._body).toHaveProperty('error');
  });

  test('returns 404 for a call belonging to another tenant', async () => {
    const call = await seedCall();

    // A user from a different organisation must not be able to read the call.
    const req = createMockRequest({ params: { callId: call.id } });
    const res = createMockResponse({ id: 'other-user-id', organisationId: 'other-org-id' });

    await getCall(req, res);

    expect(res._status).toBe(404);
    expect(res._body).toHaveProperty('error');
  });
});
