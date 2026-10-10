/**
 * Call-setup lookups against the Aplisay API, run under one time budget per call.
 *
 * Call setup used to run every lookup under a single short timer. An API that
 * answered slowly (not wrongly) then failed the setup, the worker dropped the
 * room, and LiveKit SIP answered the still-ringing INVITE with 486, so the
 * caller heard busy. The budget here is sized to the caller's patience instead:
 * a PBX gives up after 30 to 60 s and LiveKit SIP after 3 min. Inside it a slow
 * or failed attempt is retried with backoff, while a definite answer (404, a
 * trunk mismatch, any other 4xx) still fails at once.
 *
 * There is deliberately no cache across calls: the SDK runs each job in a
 * one-shot process, so nothing in-process outlives one call.
 */
import { ApiRequestError, makeApiRequest } from "./api-client.js";
import type {
  Instance,
  PhoneNumberInfo,
  PhoneRegistrationInfo,
} from "./api-client.js";
import logger from "./logger.js";

export interface SetupLookupOptions {
  /** Total time for all of one call's lookups, counted from the first. */
  budgetMs: number;
  /** The first attempt's timeout. Doubles on each retry up to maxAttemptTimeoutMs. */
  attemptTimeoutMs: number;
  maxAttemptTimeoutMs: number;
  /** The first pause before a retry. Doubles up to maxBackoffMs. */
  backoffMs: number;
  maxBackoffMs: number;
}

export const SETUP_LOOKUP_DEFAULTS: SetupLookupOptions = {
  budgetMs: 45_000,
  attemptTimeoutMs: 5_000,
  maxAttemptTimeoutMs: 20_000,
  backoffMs: 500,
  maxBackoffMs: 2_000,
};

function envInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = parseInt(env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Options from the environment; each unset or invalid variable keeps its default. */
export function setupLookupOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SetupLookupOptions {
  const d = SETUP_LOOKUP_DEFAULTS;
  return {
    budgetMs: envInt(env, "CALL_SETUP_LOOKUP_BUDGET_MS", d.budgetMs),
    attemptTimeoutMs: envInt(env, "CALL_SETUP_LOOKUP_ATTEMPT_MS", d.attemptTimeoutMs),
    maxAttemptTimeoutMs: envInt(env, "CALL_SETUP_LOOKUP_MAX_ATTEMPT_MS", d.maxAttemptTimeoutMs),
    backoffMs: envInt(env, "CALL_SETUP_LOOKUP_BACKOFF_MS", d.backoffMs),
    maxBackoffMs: envInt(env, "CALL_SETUP_LOOKUP_MAX_BACKOFF_MS", d.maxBackoffMs),
  };
}

export type ApiRequest = <T>(endpoint: string, init?: RequestInit) => Promise<T>;

export interface SetupLookupDeps {
  request?: ApiRequest;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One attempt ran out of its own time. Always retried while the budget lasts. */
export class SetupLookupAttemptTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} not answered in ${timeoutMs} ms`);
    this.name = "SetupLookupAttemptTimeoutError";
  }
}

/** The whole budget went by without a definite answer. */
export class SetupLookupTimeoutError extends Error {
  readonly label: string;
  readonly attempts: number;
  readonly elapsedMs: number;
  constructor(label: string, attempts: number, elapsedMs: number, lastError: unknown) {
    const last = lastError instanceof Error ? lastError.message : lastError ? String(lastError) : "";
    // Keep the "Call setup timeout (getCallInfo)" prefix: it is what the
    // runner logs are searched for.
    super(
      `Call setup timeout (getCallInfo): ${label} not answered in ${elapsedMs} ms after ${attempts} attempt${attempts === 1 ? "" : "s"}${last ? `: ${last}` : ""}`,
      { cause: lastError },
    );
    this.name = "SetupLookupTimeoutError";
    this.label = label;
    this.attempts = attempts;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Whether a failed attempt may succeed if repeated. Anything that is not an HTTP
 * answer (a timeout, an abort, a connection failure) counts as transient, and so
 * do the server-side statuses that say "not now".
 */
export function isTransientLookupError(error: unknown): boolean {
  if (error instanceof ApiRequestError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return true;
}

/** Lookups for one call setup. The budget starts when the instance is created. */
export class SetupLookups {
  readonly deadline: number;
  private readonly options: SetupLookupOptions;
  private readonly request: ApiRequest;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    options: Partial<SetupLookupOptions> = {},
    deps: SetupLookupDeps = {},
  ) {
    this.options = { ...SETUP_LOOKUP_DEFAULTS, ...options };
    this.request = deps.request ?? makeApiRequest;
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.deadline = this.now() + this.options.budgetMs;
  }

  /** The registration endpoint with this id, or null when there is none. */
  async phoneEndpointById(id: string): Promise<PhoneRegistrationInfo | null> {
    const result = await this.get<{ items?: PhoneRegistrationInfo[] }>(
      `phone-endpoint ${id}`,
      `/api/agent-db/phone-endpoints?id=${encodeURIComponent(id)}`,
    );
    return result?.items?.[0] ?? null;
  }

  /**
   * The number endpoint for (number, trunk), or null when there is none. A number
   * on a different trunk is a trunk mismatch (400), thrown as is: it is a refusal,
   * not a miss.
   */
  async phoneEndpointByNumber(
    number: string,
    trunkId?: string | null,
  ): Promise<PhoneNumberInfo | null> {
    let endpoint = `/api/agent-db/phone-endpoints?number=${encodeURIComponent(number)}`;
    if (trunkId) endpoint += `&trunkId=${encodeURIComponent(trunkId)}`;
    const result = await this.get<{ items?: PhoneNumberInfo[] }>(
      `phone-endpoint ${number}${trunkId ? ` on trunk ${trunkId}` : ""}`,
      endpoint,
    );
    return result?.items?.[0] ?? null;
  }

  /** The instance with its agent, or null when either is missing. */
  async instanceById(instanceId: string): Promise<Instance | null> {
    return this.get<Instance>(
      `instance ${instanceId}`,
      `/api/agent-db/instance?instanceId=${encodeURIComponent(instanceId)}`,
    );
  }

  private async get<T>(label: string, endpoint: string): Promise<T | null> {
    const started = this.now();
    let attempt = 0;
    let attemptTimeout = this.options.attemptTimeoutMs;
    let backoff = this.options.backoffMs;
    let lastError: unknown;

    for (;;) {
      const remaining = this.deadline - this.now();
      if (remaining <= 0) break;
      attempt++;
      const timeoutMs = Math.min(attemptTimeout, remaining);
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        // The race is the timeout; the abort stops the request itself so a late
        // answer is not left on the socket.
        const result = await Promise.race([
          this.request<T>(endpoint, { signal: controller.signal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new SetupLookupAttemptTimeoutError(label, timeoutMs));
            }, timeoutMs);
          }),
        ]);
        if (attempt > 1) {
          logger.info(
            { label, attempt, ms: this.now() - started },
            "setup lookup recovered",
          );
        }
        return result;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) {
          return null;
        }
        if (!isTransientLookupError(error)) {
          throw error;
        }
        lastError = error;
        const left = this.deadline - this.now();
        if (left <= backoff) break;
        logger.warn(
          { label, attempt, timeoutMs, retryInMs: backoff, remainingMs: left, err: error },
          "setup lookup failed; retrying",
        );
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, this.options.maxBackoffMs);
        attemptTimeout = Math.min(attemptTimeout * 2, this.options.maxAttemptTimeoutMs);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new SetupLookupTimeoutError(label, attempt, this.now() - started, lastError);
  }
}
