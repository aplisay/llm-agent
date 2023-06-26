const Llm = require('../lib/gpt35');
const prompt = require('../data/defaultPrompts')['gpt35']
require('./lib/llm.js')(Llm, prompt);

