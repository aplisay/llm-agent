import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

beforeAll(async () => {
  await setupRealDatabase();
}, 60000);

afterAll(async () => {
  await teardownRealDatabase();
}, 60000);

import Llm from '../lib/models/groq.js';
import prompts from '../data/defaultPrompts.js';
import testLlm from './lib/llm.js';

const prompt = prompts.gpt;
testLlm(Llm, prompt, "llama-3.1-8b-instant");
