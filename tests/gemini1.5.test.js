const Llm = require('../lib/models/gemini');
const prompt = require('../data/defaultPrompts')['google'];
require('./lib/llm.js')(Llm, prompt, "gemini-1.5-pro-preview-0409");