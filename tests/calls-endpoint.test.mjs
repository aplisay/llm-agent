import {
  setupRealDatabase,
  databaseStarted,
  teardownRealDatabase,
  Call,
  Organisation,
  User
} from './setup/database-test-wrapper.js';

describe('Calls Endpoint Test', () => {
  let listAllCalls;
  let mockLogger;

  beforeAll(async () => {
        await setupRealDatabase();
        await databaseStarted;
        const callsModule = await import('../api/paths/calls.js');
    
    mockLogger = {
      info: () => { },
      error: () => { },
      debug: () => { },
      child: () => mockLogger
    };

    const callsHandler = callsModule.default(mockLogger);
    listAllCalls = callsHandler.GET;
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

  const createMockResponse = () => {
    const res = {
      _status: null,
      _body: null,
      locals: {
        user: {
          id: 'test-user-id',
          organisationId: 'test-org-id'
        }
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

  test('should return calls including parentId and modelName', async () => {
    // Ensure an organisation and user exist that match res.locals.user
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
        // Seed a couple of calls for this organisation.
    // We disable hooks and set index explicitly to avoid the custom beforeCreate
    // logic interfering with the test while still hitting the real database.
    const parentCall = await Call.create({
      organisationId: 'test-org-id',
      userId: 'test-user-id',
      index: 1,
      parentId: null,
      modelName: 'livekit:ultravox:ultravox-70b',
      calledId: '+442080996945',
      callerId: '+443300889471',
      platform: 'test',
      platformCallId: 'pcall-1',
      metadata: {},
      options: {}
    }, { hooks: false });
    
    const childCall = await Call.create({
      organisationId: 'test-org-id',
      userId: 'test-user-id',
      index: 2,
      parentId: parentCall.id,
      modelName: 'telephony:bridged-call',
      calledId: '+442080996945',
      callerId: '+443300889470',
      platform: 'test',
      platformCallId: 'pcall-2',
      metadata: {},
      options: {}
    }, { hooks: false });
        const req = createMockRequest({ query: { limit: 10 } });
    const res = createMockResponse();

    await listAllCalls(req, res);
    
    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toBeDefined();
    expect(Array.isArray(res._body.calls)).toBe(true);
    expect(res._body.calls.length).toBeGreaterThanOrEqual(2);

    const callsById = res._body.calls.reduce((acc, c) => {
      acc[c.id] = c;
      return acc;
    }, {});
    
    expect(callsById[parentCall.id]).toBeDefined();
    expect(callsById[parentCall.id]).toHaveProperty('parentId', null);
    expect(callsById[parentCall.id]).toHaveProperty('modelName', 'livekit:ultravox:ultravox-70b');

    expect(callsById[childCall.id]).toBeDefined();
    expect(callsById[childCall.id]).toHaveProperty('parentId', parentCall.id);
    expect(callsById[childCall.id]).toHaveProperty('modelName', 'telephony:bridged-call');

    // next should either be false or a numeric index
    if (res._body.next !== false) {
      expect(typeof res._body.next === 'number' || typeof res._body.next === 'string').toBe(true);
    }
  });
});


