const Llm = require('../lib/models/openai');
const prompt = require('../data/defaultPrompts')['gpt']
require('./lib/llm.js')(Llm, prompt, 'gpt-4');

