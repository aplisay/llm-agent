const Llm = require('../lib/models/palm2');
const prompt = require('../data/defaultPrompts')['palm2'];
require('./lib/llm.js')(Llm, prompt);