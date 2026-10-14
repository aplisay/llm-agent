import { test } from "node:test";
import assert from "node:assert/strict";
import { matchUserTurnTimings } from "../plugins/ultravox/src/realtime/user_turn_timings.js";

// Ultravox's messages API records when each caller turn started and ended
// (wallClockTimespan, from the call's joined time). The plugin pairs those
// with the transcripts it emitted. Data shaped on staging call 1f9a0c72.
// run: npx tsx --test test/ultravox-user-turn-timings.test.ts

const joinedMs = Date.parse("2026-10-14T17:21:19.440213Z");
const messages = [
  { role: "MESSAGE_ROLE_AGENT", text: "Hello?", wallClockTimespan: { start: "0.286973s", end: "1.031101s" } },
  { role: "MESSAGE_ROLE_USER", text: " Thank you for calling. How can I assist you today?", wallClockTimespan: { start: "1.038358s", end: "3.437978s" } },
  { role: "MESSAGE_ROLE_AGENT", text: "Hi, I was just wondering...", wallClockTimespan: { start: "3.967588s", end: "10.762411s" } },
  { role: "MESSAGE_ROLE_USER", text: " Yes.", wallClockTimespan: { start: "14.043122s", end: "14.529386s" } },
  { role: "MESSAGE_ROLE_TOOL_CALL", text: "null", wallClockTimespan: { start: "34.114159s", end: "34.225519s" } },
  { role: "MESSAGE_ROLE_USER", text: " Yes.", wallClockTimespan: { start: "20.0s", end: "20.5s" } },
];

test("each transcript gets its own turn's start and end", () => {
  const timings = matchUserTurnTimings(
    [
      { itemId: "a", text: " Thank you for calling. How can I assist you today?" },
      { itemId: "b", text: " Yes." },
    ],
    messages,
    joinedMs,
  );
  assert.deepEqual(timings.get("a"), { startMs: joinedMs + 1038, endMs: joinedMs + 3438 });
  assert.deepEqual(timings.get("b"), { startMs: joinedMs + 14043, endMs: joinedMs + 14529 });
});

test("repeated short replies pair in order", () => {
  const timings = matchUserTurnTimings(
    [
      { itemId: "first", text: "yes" },
      { itemId: "second", text: "Yes." },
    ],
    messages.filter((m) => m.text !== " Thank you for calling. How can I assist you today?"),
    joinedMs,
  );
  assert.equal(timings.get("first")?.endMs, joinedMs + 14529);
  assert.equal(timings.get("second")?.endMs, joinedMs + 20500);
});

test("a transcript Ultravox has no message for is left out without shifting the rest", () => {
  const timings = matchUserTurnTimings(
    [
      { itemId: "missing", text: "Something Ultravox never recorded" },
      { itemId: "a", text: "Thank you for calling, how can I assist you today" },
    ],
    messages,
    joinedMs,
  );
  assert.equal(timings.has("missing"), false);
  assert.equal(timings.get("a")?.endMs, joinedMs + 3438);
});

test("a message without a timespan gives no timing", () => {
  const timings = matchUserTurnTimings(
    [{ itemId: "a", text: "Hello" }],
    [{ role: "MESSAGE_ROLE_USER", text: "Hello" }],
    joinedMs,
  );
  assert.equal(timings.size, 0);
});
