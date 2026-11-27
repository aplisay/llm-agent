import { jest } from '@jest/globals';

/**
 * A database that has not had the transcript speaker upgrade.
 * lib/database.js finds this at boot and switches the step off. The route
 * then answers 503 and reads nothing.
 */
const reads = [];
const touched = (name) => new Proxy({}, { get: (_, key) => (...args) => { reads.push(`${name}.${String(key)}`); return args; } });

jest.unstable_mockModule('../lib/database.js', () => ({
  Call: touched('Call'), CallEvent: touched('CallEvent'), Organisation: touched('Organisation'), TransactionLog: touched('TransactionLog'),
}));
jest.unstable_mockModule('../lib/outbound-places.js', () => ({ releasePlacesForEvents: async () => {} }));

const { stepOff } = await import('../lib/schema-guards.js');
const { default: route } = await import('../api/paths/agent-db/pbx/calls/{callId}/transcript.js');

describe('with the transcript speaker step off', () => {
  beforeAll(() => stepOff('transcriptSpeaker'));

  test('the transcript route answers 503 phone_system_not_ready, and reads nothing', async () => {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.send = (body) => { res.body = body; return res; };
    const callId = '0b0e3a52-7d7e-4c62-9d0a-4f2f6b9f1c11';
    await route({ error() {} }).POST({ params: { callId }, body: { texts: [{ id: callId, leg: callId, text: 'hello' }] } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('phone_system_not_ready');
    expect(reads).toEqual([]);
  });
});
