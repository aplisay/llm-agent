import Llm from '../lib/models/gemini.js.js';;
import prompt from '../data/defaultPrompts.js.js';['google'];
require('./lib/llm.js')(Llm, prompt, "gemini-1.5-pro-preview-0409");