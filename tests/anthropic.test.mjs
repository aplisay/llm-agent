import 'dotenv/config';
import Llm from '../lib/models/anthropic.js';
import prompts from '../data/defaultPrompts.js';
import testLlm from './lib/llm.js';

const prompt = prompts.anthropic;
testLlm(Llm, prompt);

