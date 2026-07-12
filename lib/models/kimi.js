import OpenAiCompatible from './openai-compatible.js';
const { KIMI_KEY } = process.env;

/**
 * Moonshot AI (Kimi) via the OpenAI-compatible international API
 * (api.moonshot.ai). K2-generation models: 262K context, automatic prefix
 * caching (cached tokens reported as usage.cached_tokens — handled in the
 * base class), strict tool-argument schemas by default. Custom temperature is
 * hard-rejected on k2.x models, so it is never forwarded (base default).
 *
 * @class Kimi
 * @extends {OpenAiCompatible}
 */
class Kimi extends OpenAiCompatible {

  static allModels = [
    ['kimi-k2.7-code', 'Moonshot Kimi K2.7 Code'],
    ['kimi-k2.7-code-highspeed', 'Moonshot Kimi K2.7 Code (high-speed)'],
    ['kimi-k2.6', 'Moonshot Kimi K2.6'],
    ['kimi-k2.5', 'Moonshot Kimi K2.5'],
  ].map(([name, description]) => ([`${this.name.toLowerCase()}/${name}`, description]));

  static get needKey() {
    return { KIMI_KEY };
  }

  static baseURL = 'https://api.moonshot.ai/v1';
  static apiKeyEnv = 'KIMI_KEY';
  static maxTokensParam = 'max_completion_tokens';
  static provider = 'moonshot';
}

export default Kimi;
