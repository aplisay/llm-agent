import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

beforeAll(async () => {
  await setupRealDatabase();
}, 60000);

afterAll(async () => {
  await teardownRealDatabase();
}, 60000);

import Llm from '../lib/models/anthropic.js';

describe('Anthropic Model Import Test', () => {
  test('should import anthropic model', () => {
    expect(Llm).toBeDefined();
    expect(typeof Llm).toBe('function');
  });
}); 