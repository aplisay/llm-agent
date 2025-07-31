import Llm from '../lib/models/openai.js';
import prompts from '../data/defaultPrompts.js';
import testLlm from './lib/llm.js';

const prompt = prompts.gpt;
testLlm(Llm, prompt, 'gpt-3.5-turbo');
testLlm(Llm, prompt, 'gpt-4');

