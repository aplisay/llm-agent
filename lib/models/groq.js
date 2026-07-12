import OpenAiCompatible from './openai-compatible.js';
const { GROQ_API_KEY } = process.env;

/**
 * Groq cloud — fast open-weight inference over the OpenAI-compatible surface.
 * Catalogue refreshed July 2026: the previous list was entirely decommissioned
 * upstream (llama3-8b-8192, mixtral-8x7b-32768, gemma-7B-it et al. are gone,
 * and requests 404'd). gpt-oss models are the durable tier (and the only ones
 * with prompt caching); the llama-3.x ids are deprecated upstream with a
 * 2026-08-16 shutdown but kept for continuity until then. All current hosted
 * models support tool use, so the old `/-70b-/` supportsFunctions regex —
 * which silently threw "Functions not supported" for most models — is gone.
 *
 * TIER LIMIT: free-tier Groq orgs are capped at 8k tokens-per-minute, which a
 * large agent (e.g. the ~37k-token builder prompt) exceeds in one request
 * (413 rate_limit_exceeded). The driver is fine — big agents on Groq need a
 * paid-tier key.
 *
 * @class Groq
 * @extends {OpenAiCompatible}
 */
class Groq extends OpenAiCompatible {

  static allModels = [
    ['openai/gpt-oss-120b', 'OpenAI GPT-OSS 120B (Groq)'],
    ['openai/gpt-oss-20b', 'OpenAI GPT-OSS 20B (Groq)'],
    ['qwen/qwen3.6-27b', 'Qwen 3.6 27B (Groq)'],
    ['llama-3.3-70b-versatile', 'Llama 3.3 70B (Groq — retiring 2026-08-16)'],
    ['llama-3.1-8b-instant', 'Llama 3.1 8B (Groq — retiring 2026-08-16)'],
  ].map(([name, description]) => ([`${this.name.toLowerCase()}/${name}`, description]));

  static get needKey() {
    return { GROQ_API_KEY };
  }

  static baseURL = 'https://api.groq.com/openai/v1';
  static apiKeyEnv = 'GROQ_API_KEY';
  static maxTokensParam = 'max_completion_tokens';
  static provider = 'groq';
}

export default Groq;
