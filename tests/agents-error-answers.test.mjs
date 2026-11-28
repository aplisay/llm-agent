/**
 * The agents routes answer a caught error with a message (and, for a validation
 * error, each item's message and path), not the caught error. The model calls
 * are replaced so each route meets a database or validation error with made-up
 * values in it.
 */
import { jest, describe, expect, test, beforeAll, afterAll, afterEach } from '@jest/globals';
import { randomUUID } from 'crypto';
import { ValidationError, ValidationErrorItem, DatabaseError } from 'sequelize';
import { setupRealDatabase, teardownRealDatabase, Agent } from './setup/database-test-wrapper.js';

const MADE_UP = 'made-up-value';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
const user = { id: randomUUID(), organisationId: randomUUID(), role: 'owner' };

function makeRes() {
  return {
    locals: { user },
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
  };
}

function databaseError() {
  const parent = Object.assign(new Error('relation "agents" is not available'), {
    code: '42P01',
    sql: `SELECT * FROM "agents" WHERE "name" = '${MADE_UP}'`,
    parameters: [MADE_UP],
  });
  return new DatabaseError(parent);
}

function validationError() {
  return new ValidationError('Validation error: Voice Example not supported by example:model', [
    new ValidationErrorItem('Voice Example not supported by example:model', 'Validation error', 'options', MADE_UP,
      { id: 'agent-1', example: MADE_UP }, 'check'),
  ]);
}

describe('agents routes error answers', () => {
  let collection, item, hook;

  beforeAll(async () => {
    await setupRealDatabase();
    collection = (await import('../api/paths/agents.js')).default(log, {}, {});
    item = (await import('../api/paths/agents/{agentId}.js')).default(log);
    hook = (await import('../api/paths/hooks/ultravox.js')).default(log, {}, {});
  }, 60000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  afterEach(() => jest.restoreAllMocks());

  test('GET /agents answers a database error with a message only', async () => {
    jest.spyOn(Agent, 'findAndCountAll').mockRejectedValue(databaseError());
    const res = makeRes();
    await collection.GET({ query: {}, params: {}, log }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain(MADE_UP);
  });

  test('GET /agents answers a plain error with the fixed message, not its own', async () => {
    jest.spyOn(Agent, 'findAndCountAll').mockRejectedValue(new Error("Cannot read properties of undefined (reading 'example')"));
    const res = makeRes();
    await collection.GET({ query: {}, params: {}, log }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: 'Internal server error' });
  });

  test('the call-end webhook route with no call in the body answers 500 with the fixed message', async () => {
    const res = makeRes();
    await hook.POST({ body: {}, params: {}, query: {}, log }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: 'Internal server error' });
  });

  test('PUT /agents/{agentId} answers a plain error with 400 and the fallback message', async () => {
    jest.spyOn(Agent, 'findOne').mockRejectedValue(new Error("Cannot read properties of undefined (reading 'example')"));
    const res = makeRes();
    await item.PUT({ params: { agentId: randomUUID() }, body: { prompt: 'Hello' }, query: {}, log }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Agent update failed' });
  });

  test('GET /agents/{agentId} answers a database error with 404 and a message', async () => {
    jest.spyOn(Agent, 'findOne').mockRejectedValue(databaseError());
    const agentId = randomUUID();
    const res = makeRes();
    await item.GET({ params: { agentId }, query: {}, log }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: `Agent with ID ${agentId} not found` });
  });

  test('PUT /agents/{agentId} answers a validation error with its messages, not the row or value', async () => {
    jest.spyOn(Agent, 'findOne').mockResolvedValue({
      name: 'Example', dataValues: {}, update: async () => { throw validationError(); },
    });
    const res = makeRes();
    await item.PUT({ params: { agentId: randomUUID() }, body: { prompt: 'Hello' }, query: {}, log }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      message: 'Validation error: Voice Example not supported by example:model',
      errors: [{ message: 'Voice Example not supported by example:model', path: 'options' }],
    });
    expect(JSON.stringify(res.body)).not.toContain(MADE_UP);
  });

  test('PUT /agents/{agentId} answers a missing agent with 404 and its message', async () => {
    jest.spyOn(Agent, 'findOne').mockResolvedValue(null);
    const agentId = randomUUID();
    const res = makeRes();
    await item.PUT({ params: { agentId }, body: { prompt: 'Hello' }, query: {}, log }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: `Agent with ID ${agentId} not found` });
  });
});
