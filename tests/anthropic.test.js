const Llm = require('../lib/models/anthropic.js');
const prompt = require('../data/defaultPrompts.js')['anthropic']
require('./lib/llm.js')(Llm, prompt);

