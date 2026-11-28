export default {
  testEnvironment: 'jest-environment-node',
  testMatch: [
    '**/tests/*.test.mjs',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/agents/',
    '.claude',
    'agent-concurrency-redis-skeleton\\.test\\.mjs',
  ],
  // No test may call a vendor or need a provider key. See tests/setup/vendor-stand-ins.js.
  setupFiles: ['./tests/setup/vendor-stand-ins.js'],
  setupFilesAfterEnv: [],
  // No test may reach a real LiveKit server. See tests/mocks/livekit-server-sdk.js.
  moduleNameMapper: {
    '^livekit-server-sdk$': '<rootDir>/tests/mocks/livekit-server-sdk.js',
    '^node-fetch$': '<rootDir>/tests/mocks/node-fetch.cjs',
    '^@google-cloud/text-to-speech$': '<rootDir>/tests/mocks/google-text-to-speech.js',
  },
  globalSetup: './tests/setup/global-setup.js',
  // Opt in to the per-worker databases created by tests/setup/global-setup.js.
  // That file is shared with the jambonz image build, which has no database.
  // noVendorCalls: global-setup.js replaces the provider settings with made-up
  // ones (tests/setup/made-up-settings.js) and preloads the network guard.
  globals: { provisionWorkerDatabases: true, noVendorCalls: true },
  testTimeout: 60000,
  // One database per worker (see tests/setup/test-db-config.js), so the suite
  // no longer has to serialise. Override with JEST_WORKERS; global-setup.js
  // reads the resolved value and creates exactly that many databases.
  maxWorkers: Number(process.env.JEST_WORKERS) || 4,
  // Under --experimental-vm-modules a worker keeps every test file's module
  // graph, about 30 MB a file, so its memory grows for the whole run. jest
  // replaces a worker whose heap is over this limit before its next file.
  workerIdleMemoryLimit: '400MB',
  verbose: true,
  collectCoverage: true,
  coverageDirectory: 'coverage/db',
  collectCoverageFrom: [
    'api/**/*.js',
    'lib/**/*.js',
    '!lib/handlers/**',
    '!lib/models/**',
    '!lib/voices/**',
    '!lib/utils/**',
    '!lib/ws-handler.js',
    '!lib/application.js',
    '!lib/agent.js',
    '!lib/gpt35.js',
    '!lib/gpt4.js',
    '!lib/palm2.js',
    '!lib/llm.js',
    '!lib/model.js',
    '!lib/jambonz.js'
  ],
  coverageReporters: ['text', 'lcov', 'html', 'json'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/tests/',
    '/coverage/',
    '/agents/',
    '/lib/handlers/',
    '/lib/models/',
    '/lib/voices/',
    '/lib/utils/',
    '/lib/ws-handler.js',
    '/lib/application.js',
    '/lib/agent.js',
    '/lib/gpt35.js',
    '/lib/gpt4.js',
    '/lib/palm2.js',
    '/lib/llm.js',
    '/lib/model.js',
    '/lib/jambonz.js'
  ],
  coverageThreshold: {
    global: {
      branches: 10,
      functions: 15,
      lines: 25,
      statements: 25
    }
  },
  transform: {}
};
