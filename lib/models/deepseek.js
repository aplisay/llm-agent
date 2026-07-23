import OpenAiCompatible from './openai-compatible.js';
const { DEEPSEEK_KEY } = process.env;

/**
 * DeepSeek via its OpenAI-compatible API (api.deepseek.com). The `deepseek-chat`
 * and `deepseek-reasoner` ids are DeepSeek's stable aliases for the current
 * V-series chat and R-series reasoner models (V4/R2 generation as of mid-2026);
 * automatic context caching reports cached tokens via usage.cached_tokens,
 * handled in the base class.
 *
 * @class Deepseek
 * @extends {OpenAiCompatible}
 */
class Deepseek extends OpenAiCompatible {

  static allModels = [
    ['deepseek-chat', 'DeepSeek Chat (latest V-series)'],
    ['deepseek-reasoner', 'DeepSeek Reasoner (latest R-series)'],
  ].map(([name, description]) => ([`${this.name.toLowerCase()}/${name}`, description]));

  static get needKey() {
    return { DEEPSEEK_KEY };
  }

  static baseURL = 'https://api.deepseek.com/v1';
  static apiKeyEnv = 'DEEPSEEK_KEY';
  static provider = 'deepseek';
}

export default Deepseek;
