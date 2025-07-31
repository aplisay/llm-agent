import Llm from '../lib/models/groq.js';
import prompts from '../data/defaultPrompts.js';
import testLlm from './lib/llm.js';

const prompt = prompts.gpt;
testLlm(Llm, prompt, "llama-3.1-8b-instant");
