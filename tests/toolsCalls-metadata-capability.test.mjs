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


describe('redact shape and field-list redaction enforcement', () => {
  class OptedIn {
    static name = 'livekit-like';
    static hasDynamicMetadata = true;
  }
  class NotOptedIn {
    static name = 'whatever';
    static hasDynamicMetadata = false;
  }
  const fn = (redact) => ({
    resolve: { implementation: 'rest', method: 'get', url: 'https://example.test/resolve', redact, input_schema: { properties: {} } },
  });

  test('allows redact as a list of property names when Handler opts in', () => {
    expect(() => validateToolsCallsMetadataUsage({ Handler: OptedIn, functions: fn(['extension', 'direct']) })).not.toThrow();
  });

  test('rejects redact as a list of property names when Handler does not opt in', () => {
    expect(() => validateToolsCallsMetadataUsage({ Handler: NotOptedIn, functions: fn(['extension']) }))
      .toThrow('Function result redaction is only allowed in handlers with hasDynamicMetadata');
  });

  test('redact: false is not a redaction request', () => {
    expect(() => validateToolsCallsMetadataUsage({ Handler: NotOptedIn, functions: fn(false) })).not.toThrow();
  });

  test('rejects an empty list even when Handler opts in', () => {
    expect(() => validateToolsCallsMetadataUsage({ Handler: OptedIn, functions: fn([]) }))
      .toThrow('redact: an empty list hides nothing');
  });

  test('rejects entries that are not non-empty strings', () => {
    expect(() => validateToolsCallsMetadataUsage({ Handler: OptedIn, functions: fn(['extension', 42]) }))
      .toThrow('redact: every entry must be a non-empty property name');
    expect(() => validateToolsCallsMetadataUsage({ Handler: OptedIn, functions: fn(['  ']) }))
      .toThrow('redact: every entry must be a non-empty property name');
  });

  test('rejects any other shape', () => {
    expect(() => validateToolsCallsMetadataUsage({ Handler: OptedIn, functions: fn('extension') }))
      .toThrow('redact must be true, false, or a list of property names');
    expect(() => validateToolsCallsMetadataUsage({ Handler: OptedIn, functions: fn({ fields: ['x'] }) }))
      .toThrow('redact must be true, false, or a list of property names');
  });
});
