import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_FINALISE_TIMEOUT_MS,
  finaliseJob,
  finaliseJobBeforeExit,
  setJobFinaliser,
} from "../lib/job-finaliser.js";
import logger from "../lib/logger.js";

// A job saves its InvocationLog and uploads its recording once, however many
// fallback attempts it makes, and before a path that exits the process itself.
// run: npx tsx --test test/job-finaliser.test.ts

logger.level = "silent";

function fakeCtx() {
  const callbacks: (() => Promise<void>)[] = [];
  return {
    ctx: { addShutdownCallback: (cb: () => Promise<void>) => void callbacks.push(cb) },
    // What agents-js does at job end.
    runShutdownCallbacks: () => Promise.allSettled(callbacks.map((cb) => cb())),
    callbacks,
  };
}

test("a job registers one shutdown callback, which runs the latest attempt's finaliser", async () => {
  const job = fakeCtx();
  const ran: string[] = [];
  for (const attempt of ["first", "second", "third"]) {
    setJobFinaliser(job.ctx, async () => void ran.push(attempt));
  }
  assert.equal(job.callbacks.length, 1);
  await job.runShutdownCallbacks();
  assert.deepEqual(ran, ["third"]);
});

test("a finaliser run before an exit is not repeated by the shutdown callback", async () => {
  const job = fakeCtx();
  const reasons: (string | undefined)[] = [];
  setJobFinaliser(job.ctx, async (reason) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    reasons.push(reason);
  });
  const beforeExit = finaliseJob(job.ctx, "Agent setup failed: boom");
  await job.runShutdownCallbacks();
  await beforeExit;
  assert.deepEqual(reasons, ["Agent setup failed: boom"]);
});

test("jobs do not share finalisers", async () => {
  const a = fakeCtx();
  const b = fakeCtx();
  const ran: string[] = [];
  setJobFinaliser(a.ctx, async () => void ran.push("a"));
  setJobFinaliser(b.ctx, async () => void ran.push("b"));
  await a.runShutdownCallbacks();
  assert.deepEqual(ran, ["a"]);
});

test("a job with no finaliser has nothing to run", async () => {
  await finaliseJob(fakeCtx().ctx);
  await finaliseJobBeforeExit(fakeCtx().ctx);
});

test("a failing finaliser is logged, not thrown at the exit path", async () => {
  const job = fakeCtx();
  setJobFinaliser(job.ctx, async () => {
    throw new Error("save failed");
  });
  await finaliseJobBeforeExit(job.ctx);
});

test("an exit path waits for the finaliser for a bounded time only", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const job = fakeCtx();
  setJobFinaliser(job.ctx, () => new Promise<void>(() => {}));
  let returned = false;
  const exiting = finaliseJobBeforeExit(job.ctx).then(() => (returned = true));
  t.mock.timers.tick(EXIT_FINALISE_TIMEOUT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  t.mock.timers.tick(1);
  await exiting;
  assert.equal(returned, true);
});

