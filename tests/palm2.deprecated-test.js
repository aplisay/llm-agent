const Llm = require('../lib/models/palm2.js');
const prompt = require('../data/defaultPrompts.js')['google'];
require('./lib/llm.js')(Llm, prompt);