const Llm = require('../lib/models/anthropic.js');
const prompt = require('../data/defaultPrompts.js')['gpt']
require('./lib/llm.js')(Llm, prompt);

