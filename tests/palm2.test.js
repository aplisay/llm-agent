const Llm = require('../lib/palm2');
const prompt = require('../data/defaultPrompts')['palm2'];
require('./lib/llm.js')(Llm, prompt);