import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSessionBounded } from "../lib/utils.js";

// closeSessionBounded backs the TransferAgent session close on every consult teardown
// path. Those paths are awaited by the PRIMARY call's shutdown — destroyInProgressTransfer
// runs immediately before that call's own end() and process.exit(0) — and an Ultravox
// session can hang in close() indefinitely (drain awaits a speech task that awaits a
// generateReply future the provider only settles when it starts the next generation).
// So the contract this locks is: never throws, never hangs.
// run: npx tsx --test test/consult-teardown.test.ts

const session = (close: () => Promise<void> | void) => ({ close });

test("no session: resolves without touching anything", async () => {
  await closeSessionBounded(null, 1000);
  await closeSessionBounded(undefined, 1000);
});

test("clean close: awaits it", async () => {
  let closed = false;
  await closeSessionBounded(
    session(async () => {
      closed = true;
    }),
    1000,
  );
  assert.equal(closed, true);
});

test("synchronous (void) close is tolerated", async () => {
  let closed = false;
  await closeSessionBounded(
    session(() => {
      closed = true;
    }),
    1000,
  );
  assert.equal(closed, true);
});

test("close that rejects does not propagate, and is reported once", async () => {
  const failures: string[] = [];
  await closeSessionBounded(
    session(async () => {
      throw new Error("websocket already gone");
    }),
    1000,
    (e) => failures.push(e.message),
  );
  assert.deepEqual(failures, ["websocket already gone"]);
});

test("close that throws synchronously does not propagate", async () => {
  const failures: string[] = [];
  await closeSessionBounded(
    session(() => {
      throw new Error("boom");
    }),
    1000,
    (e) => failures.push(e.message),
  );
  assert.deepEqual(failures, ["boom"]);
});

test("close that hangs is bounded, still resolves, and reports the timeout", async () => {
  const failures: string[] = [];
  const started = Date.now();
  // Never settles — the real Ultravox drain hang.
  await closeSessionBounded(
    session(() => new Promise<void>(() => {})),
    50,
    (e) => failures.push(e.message),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 40, `returned before the bound (${elapsed}ms)`);
  assert.ok(elapsed < 2000, `did not honour the bound (${elapsed}ms)`);
  assert.deepEqual(failures, ["session close timed out"]);
});

test("a failure is reported at most once", async () => {
  let calls = 0;
  await closeSessionBounded(
    session(async () => {
      throw new Error("nope");
    }),
    1000,
    () => {
      calls += 1;
    },
  );
  assert.equal(calls, 1);
});
