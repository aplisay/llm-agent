const Claude = require('./anthropic');
const OpenAi = require('./openai');
const Groq = require('./groq');
const Palm2 = require('./palm2');
const Gemini = require('./gemini');
const Ultravox = require('./ultravox');
const Livekit = require('./livekit');

module.exports = {
    'groq': {
      implementation: Groq,
    },
    'openai': {
      implementation: OpenAi,
    },
    'claude': {
      implementation: Claude,
    },
    'gemini': {
      implementation: Gemini,
    },
    'opensource': {
      implementation: Groq,
    },
    'ultravox': {
      implementation: Ultravox,
    },
    'livekit': {
      implementation: Livekit,
    }
};

