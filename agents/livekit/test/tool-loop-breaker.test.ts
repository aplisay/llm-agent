import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createToolLoopBreaker,
  isLoopExempt,
  TOOL_LOOP_KILL_CALLS,
  TOOL_LOOP_REFUSE_CALLS,
  TOOL_LOOP_WINDOW_MS,
} from "../lib/tool-loop-breaker.js";

// The runaway tool-call breaker refuses, and ultimately tears down, a call
// where the model spins one tool. `transfer_status` is the exception: it is a
// poll by design (the transfer result literally tells the model to poll it),
// so a normal 20-30s dialling window drove it past both thresholds and the
// breaker dropped live, correctly behaving calls mid-transfer.
// run: npx tsx --test test/tool-loop-breaker.test.ts

/** A breaker driven by a clock we control, so no test sleeps. */
function breakerAt() {
  let clock = 1_000_000;
  const note = createToolLoopBreaker(() => clock);
  return {
    note,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("a spinning non-exempt tool is refused, then killed", () => {
  const { note } = breakerAt();
  let refusedAt = 0;
  let killedAt = 0;
  for (let i = 1; i <= TOOL_LOOP_KILL_CALLS + 5; i++) {
    const v = note("lookup_order", false);
    if (v.refuse && !refusedAt) refusedAt = i;
    if (v.kill && !killedAt) killedAt = i;
  }
  assert.equal(refusedAt, TOOL_LOOP_REFUSE_CALLS + 1);
  assert.equal(killedAt, TOOL_LOOP_KILL_CALLS + 1);
});

test("an exempt tool is never refused and never kills the call", () => {
  const { note } = breakerAt();
  // Far past the kill threshold: this is the shape that was dropping calls.
  for (let i = 1; i <= TOOL_LOOP_KILL_CALLS * 4; i++) {
    const v = note("transfer_status", true);
    assert.equal(v.refuse, false, `refused on call ${i}`);
    assert.equal(v.kill, false, `killed on call ${i}`);
  }
});

test("an exempt tool still reports hot, exactly once per spell", () => {
  const { note, advance } = breakerAt();
  const hotOn: number[] = [];
  for (let i = 1; i <= TOOL_LOOP_KILL_CALLS * 2; i++) {
    if (note("transfer_status", true).hot) hotOn.push(i);
  }
  // One diagnostic on the crossing call, then silence for the rest of the
  // spell — a sustained poll must not flood the size-bounded InvocationLog.
  assert.deepEqual(hotOn, [TOOL_LOOP_REFUSE_CALLS + 1]);

  // After the window drains, a fresh spell reports again.
  advance(TOOL_LOOP_WINDOW_MS + 1);
  const again: number[] = [];
  for (let i = 1; i <= TOOL_LOOP_REFUSE_CALLS + 2; i++) {
    if (note("transfer_status", true).hot) again.push(i);
  }
  assert.deepEqual(again, [TOOL_LOOP_REFUSE_CALLS + 1]);
});

test("counts age out of the trailing window", () => {
  const { note, advance } = breakerAt();
  for (let i = 0; i < TOOL_LOOP_REFUSE_CALLS; i++) note("lookup_order", false);
  advance(TOOL_LOOP_WINDOW_MS + 1);
  const v = note("lookup_order", false);
  assert.equal(v.calls, 1);
  assert.equal(v.refuse, false);
});

test("windows are per tool name, not shared", () => {
  const { note } = breakerAt();
  for (let i = 0; i < TOOL_LOOP_REFUSE_CALLS + 2; i++) note("noisy", false);
  const quiet = note("quiet", false);
  assert.equal(quiet.calls, 1);
  assert.equal(quiet.refuse, false);
});

test("breakers are per session — a new one starts clean", () => {
  const first = breakerAt();
  for (let i = 0; i < TOOL_LOOP_REFUSE_CALLS + 2; i++) first.note("t", false);
  assert.equal(breakerAt().note("t", false).calls, 1);
});

test("exemption keys on platform, not on the author-chosen name", () => {
  // The builtin's identity is `platform`; `name` is whatever the agent author
  // called it in the definition.
  assert.equal(
    isLoopExempt({ implementation: "builtin", platform: "transfer_status" }),
    true,
  );
  // A user function that merely happens to be named transfer_status is not a
  // platform poll and stays under the breaker.
  assert.equal(
    isLoopExempt({ implementation: "rest", platform: "transfer_status" }),
    false,
  );
  // Other builtins keep their protection — nothing asks the model to poll them.
  for (const platform of ["metadata", "transfer", "hangup", "transfer_agent"]) {
    assert.equal(
      isLoopExempt({ implementation: "builtin", platform }),
      false,
      platform,
    );
  }
  assert.equal(isLoopExempt({ implementation: "builtin" }), false);
  assert.equal(isLoopExempt({}), false);
});
