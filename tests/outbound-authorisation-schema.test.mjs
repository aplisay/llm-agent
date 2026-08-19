// The outbound-authorisation request schema must accept the pipecat worker's
// actual payload, which serialises unknown fields as literal NULLS (a
// WebRTC-origin transfer has no callerId or aplisayId to send). The handler
// was always written for that shape (`callerId &&` guards, `aplisayId ||
// null`), but bare `type: 'string'` properties made express-openapi 400 the
// request before the handler ran — and the worker fails CLOSED on any
// non-200, so every human transfer out of a browser test call was refused
// with "destination could not be authorised" (beta call
// 99d15781-7e3f-436d-bdc9-9157c588eded). These tests pin the contract at the
// schema itself: every optional property is nullable, and the worker's
// real null-bearing payload validates.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Ajv = require('ajv');

describe('outbound-authorisation request schema', () => {
  let schema;

  beforeAll(async () => {
    // The endpoint module reaches lib/database.js at import time, so the test
    // database must be up before it loads (same pattern as the agent-db tests).
    await setupRealDatabase();
    const endpointModule = await import('../api/paths/agent-db/outbound-authorisation.js');
    const noopLogger = { info() {}, error() {}, warn() {}, debug() {}, child() { return this; } };
    const handlers = endpointModule.default(noopLogger, {}, {});
    schema = handlers.POST.apiDoc.requestBody.content['application/json'].schema;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 30000);

  test('every optional property is nullable (workers send literal nulls)', () => {
    const required = new Set(schema.required || []);
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (required.has(name)) continue;
      expect({ name, nullable: prop.nullable }).toEqual({ name, nullable: true });
    }
  });

  // Plain ajv is draft-07 and ignores OpenAPI's `nullable`; express-openapi
  // translates it to a type union before validating. Mirror that translation
  // so the test exercises the same semantics the middleware enforces.
  const openapiToJsonSchema = (node) => {
    if (Array.isArray(node)) return node.map(openapiToJsonSchema);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'nullable') continue;
      out[k] = openapiToJsonSchema(v);
    }
    if (node.nullable === true && typeof node.type === 'string') out.type = [node.type, 'null'];
    return out;
  };

  test("the worker's WebRTC-transfer payload (nulls for unknowns) validates", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(openapiToJsonSchema(schema));
    const payload = {
      calledId: '+447970939456',
      callerId: null,
      aplisayId: null,
      agentId: null,
      agentOptions: null,
      organisationId: 'df56af30-070a-4290-afbb-9082c2f34020',
      userId: null,
      outboundTrunkId: null,
      registrationOriginated: null,
    };
    const ok = validate(payload);
    expect({ ok, errors: validate.errors ?? null }).toEqual({ ok: true, errors: null });
  });

  test('calledId stays required', () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(openapiToJsonSchema(schema));
    expect(validate({ callerId: null })).toBe(false);
  });
});
