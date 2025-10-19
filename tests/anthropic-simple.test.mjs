import 'dotenv/config';
import Llm from '../lib/models/anthropic.js';

describe('Anthropic Model Import Test', () => {
  test('should import anthropic model', () => {
    expect(Llm).toBeDefined();
    expect(typeof Llm).toBe('function');
  });
}); 