const Llm = require('../lib/models/gpt4');
const prompt = require('../data/defaultPrompts')['gpt']
require('./lib/llm.js')(Llm, prompt);

