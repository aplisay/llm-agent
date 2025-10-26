export default {
  testEnvironment: 'jest-environment-node',
  testMatch: [
    '**/tests/*.test.mjs',
    '!**/tests/phone-endpoints-comprehensive.test.mjs',
    '!**/tests/phone-registration.test.mjs'
  ],
  setupFilesAfterEnv: [],
  globalSetup: './tests/setup/global-setup.js',
  testTimeout: 30000,
  maxWorkers: 1,
  verbose: true,
  collectCoverage: true,
  coverageDirectory: 'coverage/no-db',
  collectCoverageFrom: [
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
    '!lib/jambonz.js',
    '!lib/database.js',
    '!lib/registration-simulation.js'
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
    '/lib/jambonz.js',
    '/lib/database.js',
    '/lib/registration-simulation.js'
  ],
  coverageThreshold: {
    global: {
      branches: 0,
      functions: 0,
      lines: 0,
      statements: 0
    }
  },
  transform: {}
};
