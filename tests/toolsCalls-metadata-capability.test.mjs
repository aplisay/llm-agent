import { validateToolsCallsMetadataUsage } from '../lib/handlers/toolsCalls-metadata-capability.js';

describe('toolsCalls metadata capability enforcement', () => {
  test('allows toolsCalls.* usage when Handler opts in via hasDynamicMetadata', () => {
    class FakeLivekitLikeHandler {
      static name = 'not-livekit';
      static hasDynamicMetadata = true;
    }

    const functions = {
      toolA: {
        implementation: 'stub',
        input_schema: {
          properties: {
            x: { source: 'metadata', from: 'toolsCalls.toolA.result.transferNumber', type: 'string' },
          },
        },
      },
    };

    expect(() => validateToolsCallsMetadataUsage({ Handler: FakeLivekitLikeHandler, functions })).not.toThrow();
  });

  test('rejects toolsCalls.* usage when Handler does not opt in', () => {
    class FakeHandlerNoOptIn {
      static name = 'whatever';
      static hasDynamicMetadata = false;
    }

    const functions = {
      toolA: {
        implementation: 'stub',
        input_schema: {
          properties: {
            x: { source: 'metadata', from: 'toolsCalls.toolA.result.transferNumber', type: 'string' },
          },
        },
      },
    };

    expect(() => validateToolsCallsMetadataUsage({ Handler: FakeHandlerNoOptIn, functions }))
      .toThrow('Access to metadata.toolsCalls is only allowed in LiveKit agents');
  });

  test('rejects builtin metadata keys that reference toolsCalls when Handler does not opt in', () => {
    class FakeHandlerNoOptIn {
      static name = 'whatever';
      static hasDynamicMetadata = false;
    }

    const functions = {
      readMeta: {
        implementation: 'builtin',
        platform: 'metadata',
        input_schema: {
          properties: {
            keys: { source: 'static', from: 'toolsCalls.toolA.result.transferNumber', type: 'string' },
          },
        },
      },
    };

    expect(() => validateToolsCallsMetadataUsage({ Handler: FakeHandlerNoOptIn, functions }))
      .toThrow('Access to metadata.toolsCalls is only allowed in LiveKit agents');
  });

  test('rejects redact=true when Handler does not opt in', () => {
    class FakeHandlerNoOptIn {
      static name = 'whatever';
      static hasDynamicMetadata = false;
    }

    const functions = {
      sensitiveLookup: {
        implementation: 'stub',
        redact: true,
        input_schema: { properties: {} },
        result: '{"ok":true}',
      },
    };

    expect(() => validateToolsCallsMetadataUsage({ Handler: FakeHandlerNoOptIn, functions }))
      .toThrow('Function result redaction is only allowed in handlers with hasDynamicMetadata');
  });
});

