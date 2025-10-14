export default {
  testEnvironment: 'jest-environment-node',
  testMatch: [
    '**/tests/api/**/*.test.mjs',
    '**/tests/comprehensive/**/*.test.mjs',
    '**/tests/phone-endpoints-comprehensive.test.mjs'
  ],
  setupFilesAfterEnv: [],
  testTimeout: 60000,
  maxWorkers: 1, // Run tests sequentially to avoid database conflicts
  verbose: true,
  collectCoverage: true,
  coverageDirectory: 'coverage/comprehensive',
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
