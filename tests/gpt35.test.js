const Llm = require('../lib/models/openai');
const prompt = require('../data/defaultPrompts')['gpt']
require('./lib/llm.js')(Llm, prompt, 'gpt-3.5-turbo');

