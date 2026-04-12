import { functionHandler } from '../lib/function-handler.js';
import { jest } from '@jest/globals';

describe('function-handler metadata deep paths', () => {
  test('reads arbitrary-depth metadata paths (source: metadata) and writes tool inputs/results', async () => {
    const metadata = {
      aplisay: { callId: 'call-123' },
      deep: { nested: { value: 'x' } },
    };

    const functions = [
      {
        name: 'echoTool',
        implementation: 'stub',
        input_schema: {
          properties: {
            callId: { source: 'metadata', from: 'aplisay.callId', type: 'string' },
            deepVal: { source: 'metadata', from: 'deep.nested.value', type: 'string' },
          },
        },
        result: '{callId}-{deepVal}',
      },
    ];

    const function_calls = [{ name: 'echoTool', input: {} }];
    const messageHandler = jest.fn();

    const { function_results } = await functionHandler(
      function_calls,
      functions,
      [],
      messageHandler,
      metadata,
      {},
      { allowToolsCallsMetadataPaths: true },
    );

    expect(function_results[0].result).toBe('call-123-x');
    expect(metadata.toolsCalls.echoTool.parameter.callId).toBe('call-123');
    expect(metadata.toolsCalls.echoTool.parameter.deepVal).toBe('x');
    expect(metadata.toolsCalls.echoTool.result).toBe('call-123-x');
  });

  test('stores tool results into metadata for later tool calls', async () => {
    const metadata = { toolsCalls: {} };

    const functions = [
      {
        name: 'toolA',
        implementation: 'stub',
        input_schema: { properties: {} },
        result: '{"name":"toolA-result"}',
      },
      {
        name: 'toolB',
        implementation: 'stub',
        input_schema: {
          properties: {
            nameSource: {
              source: 'metadata',
              from: 'toolsCalls.toolA.result.name',
              type: 'string',
            },
          },
        },
        result: '{nameSource}',
      },
    ];

    const function_calls = [
      { name: 'toolA', input: {} },
      { name: 'toolB', input: {} },
    ];

    const { function_results } = await functionHandler(
      function_calls,
      functions,
      [],
      jest.fn(),
      metadata,
      {},
      { allowToolsCallsMetadataPaths: true },
    );

    expect(function_results[0].result).toBe('{"name":"toolA-result"}');
    expect(function_results[1].result).toBe('toolA-result');
    expect(metadata.toolsCalls.toolA.result).toEqual({ name: 'toolA-result' });
    expect(metadata.toolsCalls.toolB.parameter.nameSource).toBe('toolA-result');
    expect(metadata.toolsCalls.toolB.result).toBe('toolA-result');
  });

  test('built-in `metadata` helper resolves arbitrary-depth dot paths', async () => {
    const metadata = {
      aplisay: { callId: 'call-abc' },
      deep: { nested: { v: '123' } },
    };

    const functions = [
      {
        name: 'readMetadata',
        implementation: 'builtin',
        platform: 'metadata',
        input_schema: {
          properties: {
            keys: { source: 'generated', type: 'string' },
          },
        },
      },
    ];

    const function_calls = [
      { name: 'readMetadata', input: { keys: 'aplisay.callId,deep.nested.v' } },
    ];

    const { function_results } = await functionHandler(
      function_calls,
      functions,
      [],
      jest.fn(),
      metadata,
      {},
      { allowToolsCallsMetadataPaths: true },
    );

    const payload = JSON.parse(function_results[0].result);
    expect(payload['aplisay.callId']).toBe('call-abc');
    expect(payload['deep.nested.v']).toBe('123');
  });

  test('rejects toolsCalls.* metadata reads unless explicitly allowed', async () => {
    const metadata = { toolsCalls: {} };

    const functions = [
      {
        name: 'toolB',
        implementation: 'stub',
        input_schema: {
          properties: {
            nameSource: {
              source: 'metadata',
              from: 'toolsCalls.toolA.result.name',
              type: 'string',
            },
          },
        },
        result: '{nameSource}',
      },
    ];

    const function_calls = [{ name: 'toolB', input: {} }];

    await expect(
      functionHandler(
        function_calls,
        functions,
        [],
        jest.fn(),
        metadata,
        {},
      )
    ).rejects.toThrow('Access to metadata.toolsCalls is only allowed in LiveKit agents');
  });

  test('redacts successful function result to LLM while storing real metadata result', async () => {
    const metadata = {};
    const functions = [
      {
        name: 'lookupSensitive',
        implementation: 'stub',
        redact: true,
        input_schema: { properties: {} },
        result: '{"transferNumber":"+44123456789"}',
      },
    ];

    const { function_results } = await functionHandler(
      [{ name: 'lookupSensitive', input: {} }],
      functions,
      [],
      jest.fn(),
      metadata,
      {},
      { allowRedactedFunctionResults: true, allowToolsCallsMetadataPaths: true },
    );

    expect(function_results[0].result).toBe('OK - function completed');
    expect(metadata.toolsCalls.lookupSensitive.result).toEqual({ transferNumber: '+44123456789' });
  });

  test('redacts failed function result to LLM while preserving error object', async () => {
    const metadata = {};
    const functions = [
      {
        name: 'brokenLookup',
        implementation: 'rest',
        redact: true,
        method: 'get',
        url: 'http://127.0.0.1:1/never-works',
        input_schema: { properties: {} },
      },
    ];

    const { function_results } = await functionHandler(
      [{ name: 'brokenLookup', input: {} }],
      functions,
      [],
      jest.fn(),
      metadata,
      {},
      { allowRedactedFunctionResults: true, allowToolsCallsMetadataPaths: true },
    );

    expect(function_results[0].result).toBe('FAILED - invocation failed');
    expect(function_results[0].error).toBeDefined();
    expect(metadata.toolsCalls.brokenLookup.result).toBeDefined();
  });
});

