import Llm from './llm.js';
import {
  resultFunctions,
  questionsFromResultFunction,
  resultFromAnswers,
  DecisionSchemaError,
} from '../decision-questions.js';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 250;
const MAX_ATTEMPTS = 2;

// The roster id is the vendor's pinned id. OpenRouter names the same build
// `typesafe/jev-1.13` and resolves it to a dated build, reported in the
// response `model`, which the driver logs on every call. See docs/typesafe-jev.md.
const OPENROUTER_WIRE_IDS = {
  'jev-1.13.0': 'typesafe/jev-1.13',
};

const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://aplisay.com',
  'X-OpenRouter-Title': 'Aplisay llm-agent',
};

/** A failed or malformed vendor exchange. Status 502 unless the deadline is ours. */
export class DecisionRequestError extends Error {
  constructor(message, { status = 502, vendorStatus, detail, requestId } = {}) {
    super(message);
    this.name = 'DecisionRequestError';
    this.status = status;
    if (vendorStatus !== undefined) this.vendorStatus = vendorStatus;
    if (detail !== undefined) this.detail = detail;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * TypeSafe's Jev decision model (docs/typesafe-jev.md). One POST per
 * invocation: the agent's `result` function becomes the question map, the
 * prompt and the input become the state, and the typed answers become the
 * result. No chat, no tool loop, no streaming, so `completion()` throws and
 * the subagent runner calls `decide()` instead (lib/subagent.js).
 *
 * @class Typesafe
 * @extends {Llm}
 */
class Typesafe extends Llm {

  static kind = 'decision';
  static provider = 'typesafe';
  static supportsFunctions = () => true;
  static supportsMcp = () => false;

  static allModels = [
    ['typesafe/jev-1.13.0', 'TypeSafe Jev 1.13 (decision model)', { kind: 'decision' }],
  ];

  /** Test hook: replaces global fetch for every instance when set. */
  static fetchImpl = undefined;

  static get baseURL() {
    return (process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /** `openrouter` when the base URL is OpenRouter's, else `direct`. */
  static get route() {
    try {
      const { hostname } = new URL(this.baseURL);
      return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai') ? 'openrouter' : 'direct';
    } catch {
      return 'direct';
    }
  }

  /** TYPESAFE_API_KEY, else OPENROUTER_KEY on the OpenRouter route. */
  static get apiKey() {
    return process.env.TYPESAFE_API_KEY || (this.route === 'openrouter' ? process.env.OPENROUTER_KEY : undefined) || undefined;
  }

  static get needKey() {
    return { TYPESAFE_API_KEY: this.apiKey };
  }

  /** The whole budget of one decide(), including the retry. */
  static get timeoutMs() {
    const n = Number(process.env.TYPESAFE_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
  }

  /** The id sent on the wire for a roster model on the given route. */
  static wireId(model, route = this.route) {
    return route === 'openrouter' ? (OPENROUTER_WIRE_IDS[model] || `${this.provider}/${model}`) : model;
  }

  /** True when the stripped id is a roster row: pinned ids only, so `jev-latest` is never sent. */
  static isOffered(model) {
    return this.allModels.some(([id]) => id === `${this.provider}/${model}`);
  }

  constructor({ logger, user, prompt, functions, keys, options, modelName, model, rawFunctions, rawInput, fetchImpl }) {
    super({ logger, user, prompt, functions, keys, options, modelName });
    const apiKey = this.constructor.apiKey;
    if (!apiKey) {
      throw new Error(`Typesafe: TYPESAFE_API_KEY is not set${this.constructor.route === 'openrouter' ? ' (nor OPENROUTER_KEY for the OpenRouter route)' : ''}`);
    }
    this.apiKey = apiKey;
    this.model = model || modelName || this.constructor.allModels[0][0];
    if (!this.constructor.isOffered(this.model)) {
      throw new Error(`Typesafe: ${model || modelName} is not an offered decision model (pinned ids only: ${this.constructor.allModels.map(([id]) => id).join(', ')})`);
    }
    this.rawFunctions = rawFunctions;
    this.rawInput = rawInput;
    this.fetchImpl = fetchImpl || this.constructor.fetchImpl || globalThis.fetch;
  }

  async completion() {
    throw new Error('decision model: use decide()');
  }

  async callResult() {
    throw new Error('decision model: use decide()');
  }

  async close() {}

  /**
   * `{ instructions, input }` when the agent has a prompt, else the input alone. Call metadata is never sent.
   */
  buildState() {
    const instructions = typeof this.initialPrompt === 'string' ? this.initialPrompt.trim() : '';
    const input = this.rawInput;
    const emptyObject = input && typeof input === 'object' && !Array.isArray(input) && !Object.keys(input).length;
    const emptyString = typeof input === 'string' && !input.trim();
    const hasInput = input !== undefined && input !== null && !emptyObject && !emptyString;
    if (!hasInput && !instructions) {
      throw new DecisionSchemaError('a decision model needs input to decide on: send `input` or give the agent a prompt');
    }
    if (!instructions) return input;
    return { instructions, input: hasInput ? input : null };
  }

  /**
   * One decision. Returns the result (docs/typesafe-jev.md, "The result"), a
   * one-entry transcript shaped like a result call, and the usage entry the
   * subagent runner meters.
   */
  async decide() {
    const resultFn = resultFunctions(this.rawFunctions)[0];
    if (!resultFn) {
      throw new DecisionSchemaError('a decision model needs one builtin function with platform "result"');
    }
    const questions = questionsFromResultFunction(resultFn);
    const state = this.buildState();
    const route = this.constructor.route;
    const body = { model: this.constructor.wireId(this.model, route), state, questions };
    const started = Date.now();
    const { json, requestId } = await this.post(body);
    const latencyMs = Date.now() - started;
    const result = resultFromAnswers(json.answers, questions, this.options?.decision);
    const usage = {
      provider: this.constructor.provider,
      model: this.model,
      inputTokens: Math.trunc(Number(json.usage?.input_tokens)) || 0,
      outputTokens: Math.trunc(Number(json.usage?.output_tokens)) || 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    this.logger.info({
      route,
      wireId: body.model,
      model: json.model,
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost: json.usage?.cost,
      requestId,
      questions: Object.keys(questions).length,
    }, 'decision made');
    return {
      result,
      transcript: [{ function_calls: [{ name: resultFn.name, input: result }] }],
      usage,
      model: json.model,
      requestId,
    };
  }

  /**
   * POST the request inside TYPESAFE_TIMEOUT_MS with one retry on 429, 5xx or a
   * connection error. The deadline covers both attempts; its expiry is a 502
   * and is never retried. Errors carry the vendor status, `detail` and the
   * `x-typesafe-request-id` header when present.
   */
  async post(body) {
    const timeoutMs = this.constructor.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...(this.constructor.route === 'openrouter' ? OPENROUTER_HEADERS : {}),
    };
    const url = `${this.constructor.baseURL}/v1/systemone`;
    const retryDelay = () => Math.max(0, Math.min(RETRY_DELAY_MS, deadline - Date.now()));
    let lastRequestId;
    try {
      for (let attempt = 1; ; attempt++) {
        let res;
        try {
          res = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        } catch (err) {
          if (controller.signal.aborted) {
            throw new DecisionRequestError(`decision request exceeded its ${timeoutMs} ms deadline`, { requestId: lastRequestId });
          }
          if (attempt < MAX_ATTEMPTS) {
            this.logger.warn({ attempt, err: err?.message }, 'decision request failed, retrying');
            await sleep(retryDelay());
            continue;
          }
          throw new DecisionRequestError(`decision request failed: ${err?.message || err}`);
        }
        const requestId = res.headers?.get?.('x-typesafe-request-id') || undefined;
        lastRequestId = requestId || lastRequestId;
        let text;
        try {
          text = await res.text();
        } catch (err) {
          if (controller.signal.aborted) {
            throw new DecisionRequestError(`decision request exceeded its ${timeoutMs} ms deadline`, { requestId });
          }
          throw new DecisionRequestError(`decision response could not be read: ${err?.message || err}`, { vendorStatus: res.status, requestId });
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        if (res.ok) {
          if (!json || typeof json !== 'object' || !json.answers || typeof json.answers !== 'object') {
            throw new DecisionRequestError('decision response was not a JSON body with answers', { vendorStatus: res.status, requestId, detail: text.slice(0, 500) });
          }
          return { json, requestId };
        }
        const detail = json?.detail ?? json?.error ?? text.slice(0, 500);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS && Date.now() < deadline) {
          this.logger.warn({ attempt, status: res.status, requestId }, 'decision request failed, retrying');
          await sleep(retryDelay());
          continue;
        }
        throw new DecisionRequestError(
          `decision request failed with HTTP ${res.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`,
          { vendorStatus: res.status, detail, requestId });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export default Typesafe;
