import { test } from "node:test";
import assert from "node:assert/strict";
import { createCallRecordsTeardown } from "../lib/call-records-teardown.js";
import { singleFlight } from "../lib/utils.js";
import logger from "../lib/logger.js";

// The call's records end once, whichever teardown path gets there first, and
// the job's shutdown callback waits for them. consult-records-end.test.ts runs
// the same through the runtime.
// run: npx tsx --test test/call-records-teardown.test.ts

logger.level = "silent";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function steps({ transferMs = 0, callMs = 0, failTransfer = false, failCall = false } = {}) {
  const done: string[] = [];
  let consultOpen = true;
  return {
    done,
    steps: {
      // Like the worker's endTransferActivityIfNeeded: single flight, and a no-op once the consult is over.
      endTransfer: singleFlight(async (reason: string) => {
        if (!consultOpen) return;
        await sleep(transferMs);
        consultOpen = false;
        if (failTransfer) throw new Error("consult room already gone");
        done.push(`transfer: ${reason}`);
      }),
      beforeEnd: async () => {
        done.push("usage flushed");
      },
      endCall: async (reason: string) => {
        await sleep(callMs);
        if (failCall) throw new Error("API unavailable");
        done.push(`call: ${reason}`);
      },
    },
  };
}

test("end() ends the consult and the call, and the call does not wait for the consult", async () => {
  const s = steps({ transferMs: 80, callMs: 10 });
  await createCallRecordsTeardown(s.steps).end("Session closed");
  assert.deepEqual(s.done, ["usage flushed", "call: Session closed", "transfer: Session closed"]);
});

test("end() runs once; a later call shares the first run and its reason", async () => {
  const s = steps({ callMs: 20 });
  const records = createCallRecordsTeardown(s.steps);
  const first = records.end("Original participant disconnected");
  const second = records.end("Session closed");
  assert.equal(first, second);
  await second;
  await records.end("Watchdog");
  assert.deepEqual(s.done, [
    "usage flushed",
    "transfer: Original participant disconnected",
    "call: Original participant disconnected",
  ]);
});

test("a step that fails does not stop the others, and end() does not reject", async () => {
  const s = steps({ failTransfer: true });
  await createCallRecordsTeardown(s.steps).end("Session closed");
  assert.deepEqual(s.done, ["usage flushed", "call: Session closed"]);

  const t = steps({ failCall: true });
  await createCallRecordsTeardown(t.steps).end("Session closed");
  assert.deepEqual(t.done, ["usage flushed", "transfer: Session closed"]);
});

test("settle() waits for an end() already running", async () => {
  const s = steps({ transferMs: 60, callMs: 60 });
  const records = createCallRecordsTeardown(s.steps);
  void records.end("Session closed");
  await records.settle("room disconnected");
  assert.deepEqual(s.done.sort(), ["call: Session closed", "transfer: Session closed", "usage flushed"]);
});

test("settle() with no teardown started ends a consult still open, not the call", async () => {
  const s = steps();
  await createCallRecordsTeardown(s.steps).settle("shutdown");
  assert.deepEqual(s.done, ["transfer: shutdown"]);
});

test("settle() gives up after its timeout", async () => {
  const s = steps({ transferMs: 1_000 });
  const records = createCallRecordsTeardown(s.steps);
  void records.end("Session closed");
  const started = Date.now();
  await records.settle("shutdown", 50);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(s.done, ["usage flushed", "call: Session closed"]);
});

test("singleFlight: calls in flight share one run, a call after it settles starts another", async () => {
  const runs: string[] = [];
  const destroy = singleFlight(async (reason: string) => {
    runs.push(reason);
    await sleep(20);
  });
  const a = destroy("Session closed");
  const b = destroy("Original participant disconnected");
  assert.equal(a, b);
  await Promise.all([a, b]);
  await destroy("Watchdog");
  assert.deepEqual(runs, ["Session closed", "Watchdog"]);
});

test("singleFlight: a failed run rejects every caller that shared it, then clears", async () => {
  let calls = 0;
  const destroy = singleFlight(async () => {
    calls++;
    await sleep(5);
    if (calls === 1) throw new Error("boom");
  });
  const a = destroy();
  const b = destroy();
  await assert.rejects(a, /boom/);
  await assert.rejects(b, /boom/);
  await destroy();
  assert.equal(calls, 2);
});
