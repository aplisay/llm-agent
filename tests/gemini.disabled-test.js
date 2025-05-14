const Llm = require('../lib/models/gemini.js');
const prompt = require('../data/defaultPrompts.js')['google'];
require('./lib/llm.js')(Llm, prompt);