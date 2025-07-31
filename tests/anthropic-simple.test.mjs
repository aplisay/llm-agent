<<<<<<< HEAD
import 'dotenv/config';
=======
>>>>>>> 28b3218 (Refactor project to ESM)
import Llm from '../lib/models/anthropic.js';

describe('Anthropic Model Import Test', () => {
  test('should import anthropic model', () => {
    expect(Llm).toBeDefined();
    expect(typeof Llm).toBe('function');
  });
}); 