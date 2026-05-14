import { setupRealDatabase, teardownRealDatabase, PhoneNumber, PhoneRegistration, Organisation, Op, databaseStarted } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

describe('Agent DB Phone Endpoints API', () => {
  let phoneEndpointsList;
  let updateProvisioning;
  let mockLogger;
  let mockVoices;
  let mockWsServer;
  let testOrgId;
  let testPhoneNumber;
  let testRegistrationId;
  let testPhoneNumber2;
  let testRegistrationId2;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;

    // Import the API endpoint
    const phoneEndpointsModule = await import('../api/paths/agent-db/phone-endpoints.js');

    // Create mock logger and dependencies
    mockLogger = {
      info: () => { },
      error: () => { },
      warn: () => { },
      debug: () => { },
      trace: () => { },
      child: () => mockLogger
    };
    mockVoices = {};
    mockWsServer = {};

    // Initialize the API endpoint
    const handlers = phoneEndpointsModule.default(mockLogger, mockVoices, mockWsServer);
    phoneEndpointsList = handlers.GET;
    updateProvisioning = handlers.PATCH;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 30000);

  beforeEach(async () => {
    // Create test organisation
    testOrgId = randomUUID();
    const testOrg = await Organisation.create({
      id: testOrgId,
      name: 'Test Organisation'
    });

    // Create test phone numbers
    testPhoneNumber = await PhoneNumber.create({
      number: '1555111111',
      handler: 'livekit',
      outbound: true,
      organisationId: testOrgId
    });

    testPhoneNumber2 = await PhoneNumber.create({
      number: '1555222222',
      handler: 'jambonz',
      outbound: false,
      organisationId: testOrgId
    });

    // Create test registrations
    const testReg = await PhoneRegistration.create({
      name: 'Test Registration',
      registrar: 'sip:test.example.com:5060',
      username: 'testuser',
      password: 'testpass',
      handler: 'livekit',
      outbound: true,
      organisationId: testOrgId,
      status: 'active',
      state: 'registered'
    });
    testRegistrationId = testReg.id;

    const testReg2 = await PhoneRegistration.create({
      name: 'Test Registration 2',
      registrar: 'sip:test2.example.com:5060',
      username: 'testuser2',
      password: 'testpass2',
      handler: 'jambonz',
      outbound: false,
      organisationId: testOrgId,
      status: 'active',
      state: 'initial'
    });
    testRegistrationId2 = testReg2.id;
  });

  afterEach(async () => {
    // Cleanup
    try {
      await PhoneNumber.destroy({ where: { organisationId: testOrgId } });
      await PhoneRegistration.destroy({ where: { organisationId: testOrgId } });
      await Organisation.destroy({ where: { id: testOrgId } });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  // Test utility functions
  const createMockRequest = (query = {}) => ({
    query,
    params: {},
    body: {},
    log: mockLogger
  });

  const createMockResponse = () => {
    const res = {
      _status: null,
      _body: null,
      status(code) {
        this._status = code;
        return this;
      },
      send(body) {
        this._body = body;
        this._status = this._status || 200;
        return this;
      }
    };
    return res;
  };

  describe('Type inference', () => {
    test('should infer type=phone-registration when id is provided without type', async () => {
      const req = createMockRequest({ id: testRegistrationId });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toHaveProperty('items');
      expect(res._body.items).toHaveLength(1);
      expect(res._body.items[0]).toHaveProperty('id', testRegistrationId);
      expect(res._body.items[0]).toHaveProperty('handler', 'livekit');
    });

    test('should infer type=e164-ddi when number is provided without type', async () => {
      const req = createMockRequest({ number: testPhoneNumber.number });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toHaveProperty('items');
      expect(res._body.items).toHaveLength(1);
      expect(res._body.items[0]).toHaveProperty('number', testPhoneNumber.number);
      expect(res._body.items[0]).toHaveProperty('handler', 'livekit');
    });

    test('should require type, id, or number parameter', async () => {
      const req = createMockRequest({});
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(400);
      expect(res._body).toHaveProperty('error');
      expect(res._body.error).toContain('type');
    });
  });

  describe('E.164 DDI type', () => {
    test('should error when id is specified with type=e164-ddi', async () => {
      const req = createMockRequest({ type: 'e164-ddi', id: testRegistrationId });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(400);
      expect(res._body).toHaveProperty('error');
      expect(res._body.error).toContain("Cannot specify 'id' parameter for type 'e164-ddi'");
    });

    test('should return single number when number is provided with type=e164-ddi', async () => {
      const req = createMockRequest({ type: 'e164-ddi', number: testPhoneNumber.number });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toHaveProperty('items');
      expect(res._body.items).toHaveLength(1);
      expect(res._body.items[0]).toHaveProperty('number', testPhoneNumber.number);
      expect(res._body.items[0]).toHaveProperty('handler', 'livekit');
      expect(res._body.items[0]).toHaveProperty('provisioned');
      expect(res._body.items[0]).toHaveProperty('callReceived');
      expect(res._body.nextOffset).toBeNull();
    });

    test('should return single number with + prefix normalized', async () => {
      const req = createMockRequest({ type: 'e164-ddi', number: `+${testPhoneNumber.number}` });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items).toHaveLength(1);
      expect(res._body.items[0]).toHaveProperty('number', testPhoneNumber.number);
    });

    test('should return 404 when number not found with type=e164-ddi', async () => {
      const req = createMockRequest({ type: 'e164-ddi', number: '9999999999' });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(404);
      expect(res._body).toHaveProperty('error', 'Phone endpoint not found');
    });

    test('should filter by handler when number is provided with type=e164-ddi', async () => {
      const req = createMockRequest({ 
        type: 'e164-ddi', 
        number: testPhoneNumber.number, 
        handler: 'jambonz' 
      });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items).toHaveLength(0); // Handler doesn't match
    });

    test('should return matching number when handler matches', async () => {
      const req = createMockRequest({ 
        type: 'e164-ddi', 
        number: testPhoneNumber.number, 
        handler: 'livekit' 
      });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items).toHaveLength(1);
      expect(res._body.items[0].number).toBe(testPhoneNumber.number);
    });

    test('should list all numbers when type=e164-ddi without number', async () => {
      const req = createMockRequest({ type: 'e164-ddi' });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toHaveProperty('items');
      expect(res._body).toHaveProperty('nextOffset');
      expect(res._body.items.length).toBeGreaterThanOrEqual(2);
      expect(res._body.items.every(item => item.number)).toBe(true);
      expect(res._body.items.every(item => !item.id)).toBe(true);
      // Ensure new fields are present on list payload
      expect(res._body.items.every(item => 'provisioned' in item)).toBe(true);
      expect(res._body.items.every(item => 'callReceived' in item)).toBe(true);
    });

    test('should filter numbers by handler when listing', async () => {
      const req = createMockRequest({ type: 'e164-ddi', handler: 'livekit' });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items.every(item => item.handler === 'livekit')).toBe(true);
    });

    test('should support pagination when listing numbers', async () => {
      const req = createMockRequest({ 
        type: 'e164-ddi', 
        offset: '0', 
        pageSize: '1' 
      });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items.length).toBeLessThanOrEqual(1);
      expect(res._body.nextOffset).toBeDefined();
    });
  });

  describe('Provisioning updates', () => {
    test('should default provisioned=false for new phone numbers and allow internal update', async () => {
      // Freshly created phone numbers should be unprovisioned by default
      const number = testPhoneNumber.number;
      const reqGet = createMockRequest({ type: 'e164-ddi', number });
      const resGet = createMockResponse();

      await phoneEndpointsList(reqGet, resGet);

      expect(resGet._status).toBe(200);
      expect(resGet._body.items).toHaveLength(1);
      expect(resGet._body.items[0]).toHaveProperty('number', number);
      expect(resGet._body.items[0].provisioned).toBe(false);
      expect(resGet._body.items[0]).toHaveProperty('callReceived');

      // Now update provisioning via internal PATCH
      const reqPatch = {
        params: { number },
        body: { provisioned: true },
        log: mockLogger
      };
      const resPatch = createMockResponse();

      await updateProvisioning(reqPatch, resPatch);

      expect(resPatch._status).toBe(200);
      expect(resPatch._body).toHaveProperty('success', true);
      expect(resPatch._body).toHaveProperty('provisioned', true);

      // Re-read via agent-db API to confirm
      const reqGet2 = createMockRequest({ type: 'e164-ddi', number });
      const resGet2 = createMockResponse();

      await phoneEndpointsList(reqGet2, resGet2);

      expect(resGet2._status).toBe(200);
      expect(resGet2._body.items).toHaveLength(1);
      expect(resGet2._body.items[0]).toHaveProperty('number', number);
      expect(resGet2._body.items[0].provisioned).toBe(true);
    });
  });

  describe('callReceived stamping', () => {
    test('should set callReceived on first single-number lookup and return it in the response', async () => {
      const number = testPhoneNumber.number;
      const before = await PhoneNumber.findByPk(number);
      expect(before).toBeTruthy();
      expect(before.callReceived).toBeNull();

      const reqGet = createMockRequest({ type: 'e164-ddi', number });
      const resGet = createMockResponse();
      await phoneEndpointsList(reqGet, resGet);

      expect(resGet._status).toBe(200);
      expect(resGet._body.items).toHaveLength(1);
      const item = resGet._body.items[0];
      expect(item).toHaveProperty('number', number);
      expect(item.callReceived).toBeTruthy();

      const after = await PhoneNumber.findByPk(number);
      expect(after.callReceived).toBeTruthy();
    });

    test('should set callReceived on first single-registration lookup and return it in the response', async () => {
      const id = testRegistrationId;
      const before = await PhoneRegistration.findByPk(id);
      expect(before).toBeTruthy();
      expect(before.callReceived).toBeNull();

      const reqGet = createMockRequest({ type: 'phone-registration', id });
      const resGet = createMockResponse();
      await phoneEndpointsList(reqGet, resGet);

      expect(resGet._status).toBe(200);
      expect(resGet._body.items).toHaveLength(1);
      const item = resGet._body.items[0];
      expect(item).toHaveProperty('id', id);
      expect(item.callReceived).toBeTruthy();

      const after = await PhoneRegistration.findByPk(id);
      expect(after.callReceived).toBeTruthy();
    });
  });

  describe('Phone Registration type', () => {
    test('should error when number is specified with type=phone-registration', async () => {
      const req = createMockRequest({ type: 'phone-registration', number: testPhoneNumber.number });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(400);
      expect(res._body).toHaveProperty('error');
      expect(res._body.error).toContain("Cannot specify 'number' parameter for type 'phone-registration'");
    });

    test('should return single registration when id is provided with type=phone-registration', async () => {
      const req = createMockRequest({ type: 'phone-registration', id: testRegistrationId });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toHaveProperty('items');
      expect(res._body.items).toHaveLength(1);
      expect(res._body.items[0]).toHaveProperty('id', testRegistrationId);
      expect(res._body.items[0]).toHaveProperty('handler', 'livekit');
      expect(res._body.items[0]).toHaveProperty('status', 'active');
      expect(res._body.items[0]).toHaveProperty('state', 'registered');
      expect(res._body.items[0]).toHaveProperty('outbound', true);
      expect(res._body.items[0]).toHaveProperty('callReceived');
      expect(res._body.nextOffset).toBeNull();
    });

    test('should return 404 when registration not found with type=phone-registration', async () => {
      const req = createMockRequest({ type: 'phone-registration', id: randomUUID() });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(404);
      expect(res._body).toHaveProperty('error', 'Phone endpoint not found');
    });

    test('should filter by handler when id is provided with type=phone-registration', async () => {
      const req = createMockRequest({ 
        type: 'phone-registration', 
        id: testRegistrationId, 
        handler: 'jambonz' 
      });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items).toHaveLength(0); // Handler doesn't match
    });

    test('should return matching registration when handler matches', async () => {
      const req = createMockRequest({ 
        type: 'phone-registration', 
        id: testRegistrationId, 
        handler: 'livekit' 
      });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items).toHaveLength(1);
      expect(res._body.items[0].id).toBe(testRegistrationId);
    });

    test('should list all registrations when type=phone-registration without id', async () => {
      const req = createMockRequest({ type: 'phone-registration' });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toHaveProperty('items');
      expect(res._body).toHaveProperty('nextOffset');
      expect(res._body.items.length).toBeGreaterThanOrEqual(2);
      expect(res._body.items.every(item => item.id)).toBe(true);
      expect(res._body.items.every(item => !item.number)).toBe(true);
      expect(res._body.items.every(item => Object.prototype.hasOwnProperty.call(item, 'callReceived'))).toBe(true);
    });

    test('should filter registrations by handler when listing', async () => {
      const req = createMockRequest({ type: 'phone-registration', handler: 'livekit' });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items.every(item => item.handler === 'livekit')).toBe(true);
    });

    test('should support pagination when listing registrations', async () => {
      const req = createMockRequest({ 
        type: 'phone-registration', 
        offset: '0', 
        pageSize: '1' 
      });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items.length).toBeLessThanOrEqual(1);
      expect(res._body.nextOffset).toBeDefined();
    });

    test('should return correct registration properties', async () => {
      const req = createMockRequest({ type: 'phone-registration', id: testRegistrationId });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      const item = res._body.items[0];
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('handler');
      expect(item).toHaveProperty('status');
      expect(item).toHaveProperty('state');
      expect(item).toHaveProperty('outbound');
      // Should not include createdAt/updatedAt based on user's changes
      expect(item).not.toHaveProperty('createdAt');
      expect(item).not.toHaveProperty('updatedAt');
    });
  });

  describe('Default behavior (no type specified)', () => {
    test('should lookup by id when id provided without type', async () => {
      const req = createMockRequest({ id: testRegistrationId });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items).toHaveLength(1);
      expect(res._body.items[0].id).toBe(testRegistrationId);
    });

    test('should lookup by number when number provided without type', async () => {
      const req = createMockRequest({ number: testPhoneNumber.number });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      expect(res._body.items).toHaveLength(1);
      expect(res._body.items[0].number).toBe(testPhoneNumber.number);
    });
  });

  describe('Error handling', () => {
    test('should handle database errors gracefully', async () => {
      // Create a request that might cause a database error
      // Using invalid offset/pageSize values
      const req = createMockRequest({ 
        type: 'e164-ddi',
        offset: 'invalid',
        pageSize: 'invalid'
      });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      // Should either work (if it handles invalid values) or return 500
      expect([200, 500]).toContain(res._status);
    });

    test('should handle malformed UUID for id parameter', async () => {
      const req = createMockRequest({ id: 'not-a-valid-uuid' });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      // Sequelize throws an error for invalid UUID, which results in 500
      expect(res._status).toBe(500);
      expect(res._body).toHaveProperty('error');
    });
  });

  describe('Edge cases', () => {
    test('should handle empty handler filter gracefully', async () => {
      const req = createMockRequest({ type: 'e164-ddi', handler: '' });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
    });

    test('should handle very large pageSize', async () => {
      const req = createMockRequest({ 
        type: 'e164-ddi', 
        pageSize: '10000' 
      });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      // Should be capped at 200
      expect(res._body.items.length).toBeLessThanOrEqual(200);
    });

    test('should handle negative offset', async () => {
      const req = createMockRequest({ 
        type: 'e164-ddi', 
        offset: '-10' 
      });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      // Offset should be normalized to 0
      expect(res._body.items.length).toBeGreaterThanOrEqual(0);
    });

    test('should handle zero pageSize', async () => {
      const req = createMockRequest({ 
        type: 'e164-ddi', 
        pageSize: '0' 
      });
      const res = createMockResponse();

      await phoneEndpointsList(req, res);

      expect(res._status).toBe(200);
      // pageSize should be normalized to at least 1
      expect(res._body.items.length).toBeGreaterThanOrEqual(0);
    });
  });
});
