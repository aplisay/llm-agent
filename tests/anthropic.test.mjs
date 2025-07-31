<<<<<<< HEAD
import 'dotenv/config';
=======
>>>>>>> 28b3218 (Refactor project to ESM)
import Llm from '../lib/models/anthropic.js';
import prompts from '../data/defaultPrompts.js';
import testLlm from './lib/llm.js';

const prompt = prompts.anthropic;
testLlm(Llm, prompt);

