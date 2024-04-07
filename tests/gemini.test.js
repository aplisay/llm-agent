const Llm = require('../lib/models/gemini');
const prompt = require('../data/defaultPrompts')['google'];
require('./lib/llm.js')(Llm, prompt);