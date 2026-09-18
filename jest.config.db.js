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
  setupFilesAfterEnv: [],
  globalSetup: './tests/setup/global-setup.js',
  // Opt in to the per-worker databases created by tests/setup/global-setup.js.
  // That file is shared with the jambonz image build, which has no database.
  globals: { provisionWorkerDatabases: true },
  testTimeout: 60000,
  // One database per worker (see tests/setup/test-db-config.js), so the suite
  // no longer has to serialise. Override with JEST_WORKERS; global-setup.js
  // reads the resolved value and creates exactly that many databases.
  maxWorkers: Number(process.env.JEST_WORKERS) || 4,
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
