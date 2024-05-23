const Llm = require('../lib/models/openai.js');
const prompt = require('../data/defaultPrompts.js')['gpt']
require('./lib/llm.js')(Llm, prompt, 'gpt-3.5-turbo');
require('./lib/llm.js')(Llm, prompt, 'gpt-4');

