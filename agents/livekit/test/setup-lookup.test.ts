import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiRequestError } from "../lib/api-client.js";
import {
  SETUP_LOOKUP_DEFAULTS,
  SetupLookups,
  SetupLookupTimeoutError,
  isTransientLookupError,
  setupLookupOptionsFromEnv,
} from "../lib/setup-lookup.js";
import logger from "../lib/logger.js";

// Call-setup lookups retry a slow or failing API inside one budget per call and
// fail at once on a definite answer (lib/setup-lookup.ts).
// run: npx tsx --test test/setup-lookup.test.ts

logger.level = "silent";

// Short real timings: the class races a timer against the request, so mock timers
// would need the request promise to settle on the fake clock as well.
const fast = {
  budgetMs: 400,
  attemptTimeoutMs: 30,
  maxAttemptTimeoutMs: 60,
  backoffMs: 5,
  maxBackoffMs: 10,
};

interface Attempt {
  endpoint: string;
  aborted: boolean;
}

/** A fake API whose answers are scripted per attempt. `hang` never answers. */
function fakeApi(script: Array<"hang" | number | object>) {
  const attempts: Attempt[] = [];
  const request = async <T>(endpoint: string, init?: RequestInit): Promise<T> => {
    const attempt: Attempt = { endpoint, aborted: false };
    attempts.push(attempt);
    const step = script[Math.min(attempts.length, script.length) - 1];
    if (step === "hang") {
      return new Promise<T>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          attempt.aborted = true;
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }
    if (typeof step === "number") {
      throw new ApiRequestError(step, { error: `status ${step}` }, `API request failed: ${step}`);
    }
    return step as T;
  };
  return { request, attempts };
}

const registration = { items: [{ id: "reg-1", handler: "livekit", instanceId: "inst-1" }] };

test("a slow API that recovers inside the budget resolves the lookup", async () => {
  const api = fakeApi(["hang", "hang", registration]);
  const lookups = new SetupLookups(fast, { request: api.request });
  const started = Date.now();
  const result = await lookups.phoneEndpointById("reg-1");
  assert.equal(result?.id, "reg-1");
  assert.equal(api.attempts.length, 3);
  assert.ok(api.attempts[0].aborted && api.attempts[1].aborted, "hung attempts are aborted");
  assert.ok(Date.now() - started < fast.budgetMs, "answered before the budget ran out");
});

test("an API that never recovers fails with a setup timeout when the budget is spent", async () => {
  const api = fakeApi(["hang"]);
  const lookups = new SetupLookups(fast, { request: api.request });
  const started = Date.now();
  await assert.rejects(
    lookups.instanceById("inst-1"),
    (e: unknown) =>
      e instanceof SetupLookupTimeoutError &&
      e.message.startsWith("Call setup timeout (getCallInfo): instance inst-1") &&
      e.attempts === api.attempts.length,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= fast.budgetMs - 20, `used the budget (${elapsed} ms)`);
  assert.ok(elapsed < fast.budgetMs * 2, `did not run far past it (${elapsed} ms)`);
  assert.ok(api.attempts.length >= 3, `kept trying (${api.attempts.length} attempts)`);
  assert.ok(api.attempts.every((a) => a.aborted), "every hung attempt was aborted");
});

test("a 404 is a definite answer: null at once, no retry", async () => {
  const api = fakeApi([404]);
  const lookups = new SetupLookups(fast, { request: api.request });
  assert.equal(await lookups.phoneEndpointByNumber("00000", "trunk-1"), null);
  assert.equal(await lookups.instanceById("inst-1"), null);
  assert.equal(api.attempts.length, 2);
});

test("a trunk mismatch (400) is thrown as is, without retry", async () => {
  const api = fakeApi([400]);
  const lookups = new SetupLookups(fast, { request: api.request });
  await assert.rejects(
    lookups.phoneEndpointByNumber("441234", "trunk-1"),
    (e: unknown) => e instanceof ApiRequestError && e.status === 400,
  );
  assert.equal(api.attempts.length, 1);
});

test("a server error is retried and a later answer wins", async () => {
  const api = fakeApi([503, 502, { id: "inst-1", Agent: { id: "agent-1" } }]);
  const lookups = new SetupLookups(fast, { request: api.request });
  const instance = await lookups.instanceById("inst-1");
  assert.equal(instance?.Agent?.id, "agent-1");
  assert.equal(api.attempts.length, 3);
});

test("the budget is shared by every lookup of one setup", async () => {
  const api = fakeApi(["hang"]);
  const now = { t: 1_000_000 };
  const lookups = new SetupLookups(
    { ...fast, budgetMs: 100 },
    {
      request: api.request,
      now: () => now.t,
      // Each pause moves the fake clock on by the whole budget.
      sleep: async () => {
        now.t += 100;
      },
    },
  );
  await assert.rejects(lookups.phoneEndpointById("reg-1"), SetupLookupTimeoutError);
  const before = api.attempts.length;
  // A second lookup on the same setup has nothing left and makes no request.
  await assert.rejects(lookups.instanceById("inst-1"), SetupLookupTimeoutError);
  assert.equal(api.attempts.length, before);
});

test("a number is looked up by (number, trunk), and by number alone only without a trunk", async () => {
  const api = fakeApi([{ items: [] }]);
  const lookups = new SetupLookups(fast, { request: api.request });
  assert.equal(await lookups.phoneEndpointByNumber("+441234", "trunk;other"), null);
  assert.equal(await lookups.phoneEndpointByNumber("441234"), null);
  assert.deepEqual(
    api.attempts.map((a) => a.endpoint),
    [
      "/api/agent-db/phone-endpoints?number=%2B441234&trunkId=trunk%3Bother",
      "/api/agent-db/phone-endpoints?number=441234",
    ],
  );
});

test("transient means no HTTP answer, or a server-side 'not now'", () => {
  assert.equal(isTransientLookupError(new Error("socket hang up")), true);
  assert.equal(isTransientLookupError(new ApiRequestError(503, {}, "")), true);
  assert.equal(isTransientLookupError(new ApiRequestError(429, {}, "")), true);
  assert.equal(isTransientLookupError(new ApiRequestError(404, {}, "")), false);
  assert.equal(isTransientLookupError(new ApiRequestError(400, {}, "")), false);
  assert.equal(isTransientLookupError(new ApiRequestError(401, {}, "")), false);
});

test("options come from the environment, with defaults sized to a ringing caller", () => {
  assert.deepEqual(setupLookupOptionsFromEnv({}), SETUP_LOOKUP_DEFAULTS);
  // Longer than the old 5 s single timer, shorter than LiveKit SIP's 3 min ringing timeout.
  assert.ok(SETUP_LOOKUP_DEFAULTS.budgetMs > 5_000 && SETUP_LOOKUP_DEFAULTS.budgetMs < 180_000);
  assert.deepEqual(
    setupLookupOptionsFromEnv({
      CALL_SETUP_LOOKUP_BUDGET_MS: "60000",
      CALL_SETUP_LOOKUP_ATTEMPT_MS: "0",
      CALL_SETUP_LOOKUP_BACKOFF_MS: "nonsense",
    }),
    { ...SETUP_LOOKUP_DEFAULTS, budgetMs: 60_000 },
  );
});
