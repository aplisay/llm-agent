import Llm from './llm.js';
import {
  resultFunctions,
  questionsFromResultFunction,
  resultFromAnswers,
  DecisionSchemaError,
} from '../decision-questions.js';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_TIMEOUT_MS = 5000;
// setTimeout's ceiling: a larger delay fires at once.
const MAX_TIMEOUT_MS = 2147483647;
const RETRY_DELAY_MS = 250;
// A retry is only worth sending when a round trip (300 to 480 ms measured) still fits after the delay.
const MIN_ATTEMPT_MS = 500;
const MAX_ATTEMPTS = 2;
const DETAIL_MAX_CHARS = 500;

// The roster id is the vendor's pinned id. OpenRouter names the same build
// `typesafe/jev-1.13` (it refuses the bare id) and resolves it to a dated
// build, reported in the response `model`, which the driver logs on every
// call. See docs/typesafe-jev.md.
const OPENROUTER_WIRE_IDS = {
  'jev-1.13.0': 'typesafe/jev-1.13',
};

const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://aplisay.com',
  'X-OpenRouter-Title': 'Aplisay llm-agent',
};

/** A failed or malformed vendor exchange, including our own deadline. Always status 502. */
export class DecisionRequestError extends Error {
  constructor(message, { vendorStatus, detail, requestId, usage } = {}) {
    super(message);
    this.name = 'DecisionRequestError';
    this.status = 502;
    if (vendorStatus !== undefined) this.vendorStatus = vendorStatus;
    if (detail !== undefined) this.detail = detail;
    if (requestId !== undefined) this.requestId = requestId;
    if (usage !== undefined) this.usage = usage;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A vendor error body as short text for a message or a log line. */
function describeDetail(detail) {
  if (detail === undefined || detail === null || detail === '') return '';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS)}...` : text;
}

/** Retry-After in milliseconds when the header carries a delay in seconds, else undefined. */
function retryAfterMs(res) {
  const raw = res.headers?.get?.('retry-after');
  const seconds = Number(raw);
  return raw && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

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
    ['typesafe/jev-1.13.0', 'TypeSafe Jev 1.13 (decision model)'],
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
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  }

  /** The id sent on the wire for a roster model on the given route. */
  static wireId(model, route = this.route) {
    return route === 'openrouter' ? (OPENROUTER_WIRE_IDS[model] || model) : model;
  }

  /** True when the stripped id is a roster row: pinned ids only, so `jev-latest` is never sent. */
  static isOffered(model) {
    return this.allModels.some(([id]) => id === `${this.provider}/${model}`);
  }

  constructor({ logger, user, prompt, functions, keys, options, modelName, model, fetchImpl }) {
    super({ logger, user, prompt, functions, keys, options, modelName });
    const apiKey = this.constructor.apiKey;
    if (!apiKey) {
      throw new Error(`Typesafe: TYPESAFE_API_KEY is not set${this.constructor.route === 'openrouter' ? ' (nor OPENROUTER_KEY for the OpenRouter route)' : ''}`);
    }
    // Not enumerable: the handler constructor debug-logs the whole driver instance.
    Object.defineProperty(this, 'apiKey', { value: apiKey, enumerable: false, writable: false });
    this.model = model || modelName || this.constructor.allModels[0][0];
    if (!this.constructor.isOffered(this.model)) {
      throw new Error(`Typesafe: ${model || modelName} is not an offered decision model (pinned ids only: ${this.constructor.allModels.map(([id]) => id).join(', ')})`);
    }
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
  buildState(input) {
    const instructions = typeof this.initialPrompt === 'string' ? this.initialPrompt.trim() : '';
    const emptyObject = input && typeof input === 'object' && !Array.isArray(input) && !Object.keys(input).length;
    const emptyString = typeof input === 'string' && !input.trim();
    const hasInput = input !== undefined && input !== null && !emptyObject && !emptyString;
    if (!hasInput && !instructions) {
      throw new DecisionSchemaError('a decision model needs input to decide on: send `input` or give the agent a prompt');
    }
    if (!instructions) return input;
    return { instructions, input: hasInput ? input : null };
  }

  /** The usage entry the subagent runner meters, from the vendor's `usage`. */
  usageOf(json) {
    return {
      provider: this.constructor.provider,
      model: this.model,
      inputTokens: Math.trunc(Number(json?.usage?.input_tokens)) || 0,
      outputTokens: Math.trunc(Number(json?.usage?.output_tokens)) || 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  /**
   * One decision on the agent's functions (the one with platform `result`
   * is the question set) and the invocation input. Returns the result
   * (docs/typesafe-jev.md, "The result"), a one-entry transcript shaped like
   * a result call, and the usage entry the subagent runner meters. An error
   * thrown after the vendor answered carries that usage too.
   *
   * @param {{ functions?: Array|object, input?: any }} params
   */
  async decide({ functions, input } = {}) {
    const resultFn = resultFunctions(functions)[0];
    if (!resultFn) {
      throw new DecisionSchemaError('a decision model needs one builtin function with platform "result"');
    }
    const questions = questionsFromResultFunction(resultFn);
    const state = this.buildState(input);
    const route = this.constructor.route;
    const body = { model: this.constructor.wireId(this.model, route), state, questions };
    const started = Date.now();
    const { json, requestId } = await this.post(body);
    const latencyMs = Date.now() - started;
    const usage = this.usageOf(json);
    let result;
    try {
      result = resultFromAnswers(json.answers, questions, this.options?.decision);
    } catch (err) {
      this.logger.warn({ route, model: json.model, requestId, err: err?.message }, 'decision answers did not fit the questions');
      if (err && typeof err === 'object') err.usage = usage;
      throw err;
    }
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
   * connection error, sent only while a round trip still fits in the budget.
   * The deadline covers both attempts; its expiry is a 502 and is never
   * retried. Every failure is logged with the vendor status, the request id
   * (the vendor's header, else OpenRouter's generation id) and the detail.
   */
  async post(body) {
    const timeoutMs = this.constructor.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    const remaining = () => deadline - Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...(this.constructor.route === 'openrouter' ? OPENROUTER_HEADERS : {}),
    };
    const url = `${this.constructor.baseURL}/v1/systemone`;
    const payload = JSON.stringify(body);
    const fail = (message, fields) => {
      this.logger.warn({ ...fields, detail: describeDetail(fields.detail) || undefined }, 'decision request failed');
      return new DecisionRequestError(message, fields);
    };
    const canRetry = (attempt, delay) => attempt < MAX_ATTEMPTS && remaining() >= delay + MIN_ATTEMPT_MS;
    try {
      for (let attempt = 1; ; attempt++) {
        let res;
        try {
          res = await this.fetchImpl(url, { method: 'POST', headers, body: payload, signal: controller.signal });
        } catch (err) {
          if (controller.signal.aborted) {
            throw fail(`decision request exceeded its ${timeoutMs} ms deadline`, { attempt });
          }
          if (canRetry(attempt, RETRY_DELAY_MS)) {
            this.logger.warn({ attempt, err: err?.message }, 'decision request failed, retrying');
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          throw fail(`decision request failed: ${err?.message || err}`, { attempt, detail: err?.message });
        }
        let text;
        try {
          text = await res.text();
        } catch (err) {
          if (controller.signal.aborted) {
            throw fail(`decision request exceeded its ${timeoutMs} ms deadline`, { attempt, vendorStatus: res.status });
          }
          throw fail(`decision response could not be read: ${err?.message || err}`, { attempt, vendorStatus: res.status });
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        const requestId = res.headers?.get?.('x-typesafe-request-id')
          || (typeof json?.id === 'string' ? json.id : undefined)
          || res.headers?.get?.('x-generation-id')
          || undefined;
        if (res.ok) {
          if (!json || typeof json !== 'object' || !json.answers || typeof json.answers !== 'object') {
            // The vendor billed the exchange even though the body is unusable.
            throw fail('decision response was not a JSON body with answers', {
              attempt, vendorStatus: res.status, requestId, detail: text,
              ...(json?.usage ? { usage: this.usageOf(json) } : {}),
            });
          }
          return { json, requestId };
        }
        const detail = json?.detail ?? json?.error ?? text;
        const retryable = res.status === 429 || res.status >= 500;
        const delay = Math.max(RETRY_DELAY_MS, retryAfterMs(res) ?? 0);
        if (retryable && canRetry(attempt, delay)) {
          this.logger.warn({ attempt, status: res.status, requestId, delay }, 'decision request failed, retrying');
          await sleep(delay);
          continue;
        }
        const summary = describeDetail(detail);
        throw fail(`decision request failed with HTTP ${res.status}${summary ? `: ${summary}` : ''}`,
          { attempt, vendorStatus: res.status, detail, requestId });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export default Typesafe;
