import OpenAiCompatible from './openai-compatible.js';
const { OPENROUTER_KEY } = process.env;

/**
 * OpenRouter — one key, many vendors' models over the OpenAI-compatible
 * surface. The curated catalogue below is the July-2026 tool-calling set
 * worth offering for agentic work (verified against /api/v1/models
 * ?supported_parameters=tools); extend via OPENROUTER_MODELS
 * ("id|description,id|description"). Model ids contain their vendor segment
 * ('moonshotai/kimi-k2.6'), which the base class's model setter preserves.
 *
 * Requests carrying tools are automatically routed only to tool-capable
 * providers; `require_parameters` is set as well so a provider that would
 * silently drop request params is never picked.
 *
 * UNVERIFIED EDGE (billing): for anthropic/* models it is not documented
 * whether OpenRouter's normalised usage.prompt_tokens INCLUDES cache-read
 * tokens (Anthropic-native input_tokens EXCLUDES them). If it mirrors the
 * native exclusion, usageOf()'s cached-token subtraction would under-meter
 * inputTokens on warm requests for those models only. Check one warm response
 * empirically before using openrouter/anthropic/* for billing-sensitive
 * traffic; the other catalogued vendors follow the documented subset
 * convention the subtraction assumes.
 *
 * @class OpenRouter
 * @extends {OpenAiCompatible}
 */
class OpenRouter extends OpenAiCompatible {

  static allModels = [
    ['moonshotai/kimi-k2.7-code', 'Kimi K2.7 Code (OpenRouter)'],
    ['moonshotai/kimi-k2.6', 'Kimi K2.6 (OpenRouter)'],
    ['deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro (OpenRouter)'],
    ['deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash (OpenRouter)'],
    ['qwen/qwen3.7-max', 'Qwen 3.7 Max (OpenRouter)'],
    ['z-ai/glm-5.2', 'Zhipu GLM 5.2 (OpenRouter)'],
    ['minimax/minimax-m3', 'MiniMax M3 (OpenRouter)'],
    ['meta-llama/llama-4-maverick', 'Llama 4 Maverick (OpenRouter)'],
    ['google/gemini-3.5-flash', 'Gemini 3.5 Flash (OpenRouter)'],
    ['openai/gpt-5.6-terra', 'GPT-5.6 Terra (OpenRouter)'],
    ['anthropic/claude-sonnet-5', 'Claude Sonnet 5 (OpenRouter)'],
    ...(process.env.OPENROUTER_MODELS || '')
      .split(',')
      .map((row) => row.trim())
      .filter(Boolean)
      .map((row) => {
        const [id, description] = row.split('|').map((s) => s.trim());
        return [id, description || `${id} (OpenRouter)`];
      }),
  ].map(([name, description]) => ([`${this.name.toLowerCase()}/${name}`, description]));

  static get needKey() {
    return { OPENROUTER_KEY };
  }

  static baseURL = 'https://openrouter.ai/api/v1';
  static apiKeyEnv = 'OPENROUTER_KEY';
  static extraHeaders = {
    'HTTP-Referer': 'https://aplisay.com',
    'X-OpenRouter-Title': 'Aplisay llm-agent',
  };
  // OpenRouter normalises max_tokens across vendors.
  static maxTokensParam = 'max_tokens';
  static provider = 'openrouter';

  requestBody(tools) {
    const body = super.requestBody(tools);
    if (tools.length) {
      // Never route to a provider that would silently ignore request params.
      body.provider = { require_parameters: true };
    }
    const effort = this._options?.effort;
    if (effort) body.reasoning = { effort };
    return body;
  }
}

export default OpenRouter;
