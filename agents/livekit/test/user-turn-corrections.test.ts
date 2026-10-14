import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createUserTurnCorrections,
  CORRECTION_SKEW_MS,
  type LoggedTransactionLog,
  type TransactionLogCorrection,
} from "../lib/user-turn-corrections.js";
import type { Call } from "../lib/api-client.js";

// Before a call record ends, its `user` rows take Ultravox's own end-of-turn
// times: batched entries are rewritten, streamed rows become corrections the
// end request applies. Anything doubtful keeps the live guess.
// run: npx tsx --test test/user-turn-corrections.test.ts

type TestCall = Call & { transactionLogCorrections?: TransactionLogCorrection[] };
const newCall = (id: string) => ({ id }) as unknown as TestCall;

const source = (timings: Record<string, number>) => ({
  userTurnTimings: async () =>
    new Map(Object.entries(timings).map(([itemId, endMs]) => [itemId, { startMs: endMs - 1000, endMs }])),
});

const batched = (call: Call, createdAt: Date): LoggedTransactionLog => ({ call, entry: { createdAt } });

test("batched entries get Ultravox's end-of-turn time", async () => {
  const call = newCall("c1");
  const corrections = createUserTurnCorrections();
  const guess = new Date(23_408);
  const log = batched(call, guess);
  corrections.add({ itemId: "a", guess, source: source({ a: 22_878 }), logged: Promise.resolve(log) });

  await corrections.beforeEnd(call);

  assert.equal(log.entry!.createdAt!.getTime(), 22_878);
  assert.equal(call.transactionLogCorrections, undefined);
});

test("streamed rows become corrections on their call record", async () => {
  const call = newCall("c1");
  const corrections = createUserTurnCorrections();
  corrections.add({
    itemId: "a",
    guess: new Date(31_051),
    source: source({ a: 30_548 }),
    logged: Promise.resolve({ call, id: 42 }),
  });

  await corrections.beforeEnd(call);

  assert.deepEqual(call.transactionLogCorrections, [{ id: 42, createdAt: new Date(30_548) }]);
});

test("only the ending call's rows are corrected, and the rest wait for theirs", async () => {
  const agentCall = newCall("agent");
  const childCall = newCall("child");
  const corrections = createUserTurnCorrections();
  const timings = source({ a: 1_000, b: 5_000 });
  const first = batched(agentCall, new Date(1_500));
  const second = batched(childCall, new Date(5_500));
  corrections.add({ itemId: "a", guess: new Date(1_500), source: timings, logged: Promise.resolve(first) });
  corrections.add({ itemId: "b", guess: new Date(5_500), source: timings, logged: Promise.resolve(second) });

  await corrections.beforeEnd(agentCall);
  assert.equal(first.entry!.createdAt!.getTime(), 1_000);
  assert.equal(second.entry!.createdAt!.getTime(), 5_500);

  await corrections.beforeEnd(childCall);
  assert.equal(second.entry!.createdAt!.getTime(), 5_000);
});

test("a time later than the guess, or out of order, keeps the guess", async () => {
  const call = newCall("c1");
  const corrections = createUserTurnCorrections();
  const late = batched(call, new Date(10_000));
  const backwards = batched(call, new Date(20_000));
  corrections.add({
    itemId: "late",
    guess: new Date(10_000),
    source: source({ late: 10_000 + CORRECTION_SKEW_MS + 1, backwards: 9_000 }),
    logged: Promise.resolve(late),
  });
  corrections.add({
    itemId: "backwards",
    guess: new Date(20_000),
    source: source({ late: 10_000 + CORRECTION_SKEW_MS + 1, backwards: 9_000 }),
    logged: Promise.resolve(backwards),
  });

  await corrections.beforeEnd(call);

  assert.equal(late.entry!.createdAt!.getTime(), 10_000);
  assert.equal(backwards.entry!.createdAt!.getTime(), 20_000);
});

test("rows from a model with no timings, or an unmatched turn, keep the guess", async () => {
  const call = newCall("c1");
  const corrections = createUserTurnCorrections();
  const noSource = batched(call, new Date(1_000));
  const unmatched = batched(call, new Date(2_000));
  corrections.add({ itemId: "a", guess: new Date(1_000), source: undefined, logged: Promise.resolve(noSource) });
  corrections.add({ itemId: "b", guess: new Date(2_000), source: source({}), logged: Promise.resolve(unmatched) });

  await corrections.beforeEnd(call);

  assert.equal(noSource.entry!.createdAt!.getTime(), 1_000);
  assert.equal(unmatched.entry!.createdAt!.getTime(), 2_000);
});

test("a slow timings fetch times out and the call ends with its guesses", async () => {
  const call = newCall("c1");
  const corrections = createUserTurnCorrections({ timeoutMs: 20 });
  const log = batched(call, new Date(1_000));
  corrections.add({
    itemId: "a",
    guess: new Date(1_000),
    source: { userTurnTimings: () => new Promise(() => {}) },
    logged: Promise.resolve(log),
  });

  await corrections.beforeEnd(call);

  assert.equal(log.entry!.createdAt!.getTime(), 1_000);
});

test("a failing timings fetch does not throw", async () => {
  const call = newCall("c1");
  const corrections = createUserTurnCorrections();
  const log = batched(call, new Date(1_000));
  corrections.add({
    itemId: "a",
    guess: new Date(1_000),
    source: { userTurnTimings: async () => Promise.reject(new Error("Ultravox down")) },
    logged: Promise.resolve(log),
  });

  await corrections.beforeEnd(call);

  assert.equal(log.entry!.createdAt!.getTime(), 1_000);
});
