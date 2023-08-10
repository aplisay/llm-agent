const Llm = require('../lib/gpt4');
const prompt = require('../data/defaultPrompts')['gpt35']
require('./lib/llm.js')(Llm, prompt);

