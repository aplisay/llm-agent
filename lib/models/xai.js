import OpenAiCompatible from './openai-compatible.js';
import defaultLogger from '../logger.js';
import { XAI_VOICES_URL, mapXaiVoices, xaiVoiceTree } from '../voices/xai.js';

const EFFORT_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
// The 4.20 models reject reasoning_effort outright ("does not support
// parameter reasoningEffort"); 4.6 rejects the value `none`. Checked against
// the API on 2026-09-15 (research/grok-spike-findings.md in the strategy repo).
const NO_EFFORT_PARAM = /^grok-4\.20-/;
const NO_NONE_EFFORT = /^grok-4\.6/;
const VOICES_FETCH_TIMEOUT_MS = 5000;

/**
 * xAI Grok text models via the OpenAI-compatible chat completions API
 * (api.x.ai). Tool calling, streaming (with `reasoning_content` deltas on the
 * reasoning models) and automatic prompt caching, reported as
 * `prompt_tokens_details.cached_tokens` and handled in the base class.
 *
 * `options.effort` maps to `reasoning_effort` (docs/grok.md); `temperature`
 * is forwarded on the non-reasoning model only. The key is `XAI_API_KEY`,
 * with `GROK_API_KEY` accepted as a fallback. The class also owns the xAI
 * voice catalogue the voice handlers publish for the Grok voice rows.
 *
 * @class Xai
 * @extends {OpenAiCompatible}
 */
class Xai extends OpenAiCompatible {

  static allModels = [
    ['grok-4.6', 'xAI Grok 4.6'],
    ['grok-4.3', 'xAI Grok 4.3'],
    ['grok-4.20-0309-reasoning', 'xAI Grok 4.20 (reasoning)'],
    ['grok-4.20-0309-non-reasoning', 'xAI Grok 4.20 (non-reasoning)'],
  ].map(([name, description]) => ([`${this.name.toLowerCase()}/${name}`, description]));

  static get needKey() {
    return { XAI_API_KEY: Xai.apiKey };
  }

  /** The platform key: `XAI_API_KEY`, else the older `GROK_API_KEY`. */
  static get apiKey() {
    return process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  }

  // The base constructor reads process.env[apiKeyEnv]; name whichever
  // variable is set, and the canonical one in the "not set" error.
  static get apiKeyEnv() {
    return !process.env.XAI_API_KEY && process.env.GROK_API_KEY ? 'GROK_API_KEY' : 'XAI_API_KEY';
  }

  static baseURL = 'https://api.x.ai/v1';
  static maxTokensParam = 'max_tokens';
  static allowTemperature = true;
  static provider = 'xai';

  /** True unless the id names the non-reasoning variant. */
  static isReasoningModel(model) {
    return !/non-reasoning/.test(String(model || ''));
  }

  /** The `reasoning_effort` value safe to send for this model, or undefined to omit. */
  static effortFor(model, requested, logger = defaultLogger) {
    if (!requested) return undefined;
    if (!EFFORT_LEVELS.has(requested)) {
      logger.warn({ effort: requested }, 'ignoring unknown options.effort value');
      return undefined;
    }
    if (NO_EFFORT_PARAM.test(model)) return undefined;
    const effort = requested === 'max' ? 'xhigh' : requested;
    if (effort === 'none' && NO_NONE_EFFORT.test(model)) return 'low';
    return effort;
  }

  requestBody(tools) {
    const body = super.requestBody(tools);
    if (Xai.isReasoningModel(this.gpt.model)) delete body.temperature;
    const effort = Xai.effortFor(this.gpt.model, this._options?.effort, this.logger);
    if (effort) body.reasoning_effort = effort;
    return body;
  }

  static _voices;

  /**
   * The xAI voice block, fetched once from the catalogue endpoint with the
   * platform key and falling back to the static list (lib/voices/xai.js).
   * A promise, like the Ultravox handler's catalogue.
   */
  static get voices() {
    if (!Xai._voices) Xai._voices = Xai.fetchVoices();
    return Xai._voices;
  }

  static async fetchVoices({ fetchImpl = fetch, key = Xai.apiKey, logger = defaultLogger } = {}) {
    if (!key) {
      logger.warn('neither XAI_API_KEY nor GROK_API_KEY is set, using the static xAI voice list');
      return xaiVoiceTree();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VOICES_FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(XAI_VOICES_URL, {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = mapXaiVoices(await res.json());
      if (!rows.length) throw new Error('empty voice list');
      return xaiVoiceTree(rows);
    } catch (e) {
      logger.warn({ error: e?.message }, 'xAI voice catalogue fetch failed, using the static list');
      return xaiVoiceTree();
    } finally {
      clearTimeout(timer);
    }
  }
}

export default Xai;
