const Llm = require('../lib/models/gpt35');
const prompt = require('../data/defaultPrompts')['gpt']
require('./lib/llm.js')(Llm, prompt);

