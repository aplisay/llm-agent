/**
 * Error answers carry a message, and log entries leave out the failed request's
 * settings. All values are made up and no request leaves the process: the HTTP
 * client's adapter refuses every request itself.
 */
import { describe, expect, test } from '@jest/globals';
import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import { Writable } from 'stream';
import axios, { AxiosError } from 'axios';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { ValidationError, ValidationErrorItem, DatabaseError } from 'sequelize';
import { errorBody, errorForLog, internalErrorBody } from '../lib/error-answers.js';
import { serializers } from '../lib/logger.js';

const MADE_UP = 'made-up-value';

/** An HTTP client error for a refused request that carried a made-up header and query. */
async function httpClientError() {
  const client = axios.create({
    baseURL: 'https://api.example.test/v1/',
    headers: { 'X-Example': MADE_UP },
    adapter: async (config) => {
      throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, {},
        { status: 403, statusText: 'Forbidden', data: { detail: `refused ${MADE_UP}` }, headers: {}, config });
    },
  });
  return client.post('/voices?page=2&extra=made-up-query', { field: MADE_UP }).catch((err) => err);
}

function databaseError() {
  const parent = Object.assign(new Error('invalid input syntax for type uuid: "abc"'), {
    code: '22P02',
    sql: `SELECT * FROM "agents" WHERE "id" = '${MADE_UP}'`,
    parameters: [MADE_UP],
  });
  return new DatabaseError(parent);
}

function validationError() {
  const instance = { id: 'agent-1', example: MADE_UP };
  return new ValidationError('Validation error: Voice Example not supported by example:model', [
    new ValidationErrorItem('Voice Example not supported by example:model', 'Validation error', 'options', MADE_UP, instance, 'check'),
  ]);
}

describe('errorBody', () => {
  test('an HTTP client error gives the fallback message only', async () => {
    const err = await httpClientError();
    expect(err.config.headers['X-Example']).toBe(MADE_UP);
    const body = errorBody(err, 'Example failed');
    expect(body).toEqual({ message: 'Example failed' });
    expect(JSON.stringify(body)).not.toContain(MADE_UP);
  });

  test('a database error gives the fallback message, with no SQL or parameters', () => {
    const err = databaseError();
    expect(err.sql).toContain(MADE_UP);
    const body = errorBody(err, 'Agent with ID abc not found');
    expect(body).toEqual({ message: 'Agent with ID abc not found' });
  });

  test('a validation error keeps its message and each item\'s message and path', () => {
    const body = errorBody(validationError(), 'Example failed');
    expect(body).toEqual({
      message: 'Validation error: Voice Example not supported by example:model',
      errors: [{ message: 'Voice Example not supported by example:model', path: 'options' }],
    });
    expect(JSON.stringify(body)).not.toContain(MADE_UP);
  });

  test('a plain error gives the fallback message, not its own', () => {
    expect(errorBody(new Error('Cannot read properties of undefined'), 'Example failed')).toEqual({ message: 'Example failed' });
  });

  test('something that is not an error gives the fallback message', () => {
    expect(errorBody('a string', 'Nothing here')).toEqual({ message: 'Nothing here' });
    expect(errorBody(undefined, 'Nothing here')).toEqual({ message: 'Nothing here' });
  });
});

describe('internalErrorBody', () => {
  test('is the fixed message', () => {
    expect(internalErrorBody()).toEqual({ message: 'Internal server error' });
  });
});

describe('errorForLog', () => {
  test('an HTTP client error keeps the message, code, status, method and URL path only', async () => {
    const entry = errorForLog(await httpClientError());
    expect(entry).toMatchObject({
      type: 'AxiosError',
      name: 'AxiosError',
      message: 'Request failed with status code 403',
      code: 'ERR_BAD_REQUEST',
      status: 403,
      method: 'POST',
      url: 'https://api.example.test/v1/voices',
    });
    expect(entry).not.toHaveProperty('config');
    expect(entry).not.toHaveProperty('request');
    expect(entry).not.toHaveProperty('response');
    const text = JSON.stringify(entry);
    expect(text).not.toContain(MADE_UP);
    expect(text).not.toContain('made-up-query');
  });

  test('a database error leaves out the SQL and parameters and keeps the database code', () => {
    const entry = errorForLog(databaseError());
    expect(entry).toMatchObject({ name: 'SequelizeDatabaseError', code: '22P02', message: 'invalid input syntax for type uuid: "abc"' });
    expect(entry).not.toHaveProperty('sql');
    expect(entry).not.toHaveProperty('parameters');
    expect(JSON.stringify(entry)).not.toContain(MADE_UP);
  });

  test('a validation error keeps the item messages, not the values or the row', () => {
    const entry = errorForLog(validationError());
    expect(entry.errors).toEqual([{ message: 'Voice Example not supported by example:model', path: 'options' }]);
    expect(JSON.stringify(entry)).not.toContain(MADE_UP);
  });

  test('a value that is not an error is left as it is', () => {
    expect(errorForLog('just text')).toBe('just text');
  });
});

describe('error middleware', () => {
  test('each item of `errors` carries its named fields only', async () => {
    const { default: handleError } = await import('../middleware/errors.js');
    const err = Object.assign(new Error('request validation failed'), {
      status: 400,
      errors: [{ path: 'name', errorCode: 'type.openapi.requestValidation', message: 'must be string', location: 'body', instance: { example: MADE_UP } }],
    });
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    handleError(err, {}, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body.errors).toEqual([{ path: 'name', errorCode: 'type.openapi.requestValidation', message: 'must be string', location: 'body' }]);
    expect(JSON.stringify(res.body)).not.toContain(MADE_UP);
  });
});

describe('log entries', () => {
  function capture() {
    const lines = [];
    const stream = new Writable({ write(chunk, _enc, done) { lines.push(JSON.parse(chunk)); done(); } });
    return { lines, stream };
  }

  test('the logger\'s err serializer leaves out the failed request\'s settings', async () => {
    const { lines, stream } = capture();
    const log = pino({ serializers }, stream);
    log.error(await httpClientError(), 'getting voices');
    expect(lines[0].err).toMatchObject({ message: 'Request failed with status code 403', method: 'POST', url: 'https://api.example.test/v1/voices', status: 403 });
    expect(JSON.stringify(lines[0])).not.toContain(MADE_UP);
  });

  test('a request logger made by pino-http with the same serializers does too', async () => {
    const { lines, stream } = capture();
    const middleware = pinoHttp({ logger: pino({ serializers }, stream), serializers });
    const req = new IncomingMessage(new Socket());
    req.method = 'GET';
    req.url = '/api/voices';
    middleware(req, new ServerResponse(req), () => {});
    req.log.error(await httpClientError(), 'getting voices');
    const entry = lines.find((line) => line.msg === 'getting voices');
    expect(entry.err).toMatchObject({ code: 'ERR_BAD_REQUEST', url: 'https://api.example.test/v1/voices' });
    expect(entry.err).not.toHaveProperty('config');
    expect(JSON.stringify(entry)).not.toContain(MADE_UP);
  });
});
