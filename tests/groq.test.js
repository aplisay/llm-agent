const Llm = require('../lib/models/groq.js');
const prompt = require('../data/defaultPrompts.js')['gpt'];
require('./lib/llm.js')(Llm, prompt, "llama-3.1-8b-instant");
