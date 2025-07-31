import Claude from './anthropic.js';
import OpenAi from './openai.js';
import Groq from './groq.js';
import Palm2 from './palm2.js';
import Gemini from './gemini.js';
import Ultravox from './ultravox.js';
import Livekit from './livekit.js';

export const models = {
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

