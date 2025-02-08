const Llm = require('../lib/models/gemini.js');
const prompt = require('../data/defaultPrompts.js')['google'];
require('./lib/llm.js')(Llm, prompt, "gemini-1.5-pro-preview-0409");