import { test } from "node:test";
import assert from "node:assert/strict";
import { createUserTurnClock, RESPONSE_TRANSCRIPT_WINDOW_MS } from "../lib/user-turn-clock.js";

// The live `user` row time: the earliest sign that the caller had stopped.
// Ultravox sends the caller's transcript 0.2 to 0.7 s after its reply starts
// (staging, 2026-10-14), so the reply start is closer than the arrival.
// run: npx tsx --test test/user-turn-clock.test.ts

const noMetrics = {};

test("with no other signal the row keeps the arrival time", () => {
  const clock = createUserTurnClock();
  assert.equal(clock.stamp(noMetrics, 10_000).getTime(), 10_000);
});

test("an Ultravox reply that started before the transcript arrived gives the time", () => {
  const clock = createUserTurnClock();
  clock.noteResponseStarted(23_408);
  assert.equal(clock.stamp(noMetrics, 23_736).getTime(), 23_408);
});

test("a tool call that started the reply gives the time", () => {
  const clock = createUserTurnClock();
  clock.noteResponseStarted(31_051);
  assert.equal(clock.stamp(noMetrics, 31_319).getTime(), 31_051);
});

test("a pipeline item's own end of speech wins", () => {
  const clock = createUserTurnClock();
  clock.noteUserStopped(50_400);
  assert.equal(clock.stamp({ metrics: { stoppedSpeakingAt: 50.1 } }, 51_200).getTime(), 50_100);
});

test("a provider's user-stopped event beats the later reply start", () => {
  const clock = createUserTurnClock();
  clock.noteUserStarted(40_000);
  clock.noteUserStopped(42_300);
  clock.noteResponseStarted(42_900);
  assert.equal(clock.stamp(noMetrics, 43_500).getTime(), 42_300);
});

test("a reply start older than the window belongs to an earlier turn", () => {
  const clock = createUserTurnClock();
  clock.noteResponseStarted(10_000);
  const arrived = 10_000 + RESPONSE_TRANSCRIPT_WINDOW_MS + 1;
  assert.equal(clock.stamp(noMetrics, arrived).getTime(), arrived);
});

test("a reply start from before the caller began speaking is ignored", () => {
  const clock = createUserTurnClock();
  clock.noteResponseStarted(20_000);
  clock.noteUserStarted(20_500);
  clock.noteUserStopped(21_400);
  assert.equal(clock.stamp(noMetrics, 21_900).getTime(), 21_400);
});

test("each signal is used once, and rows never go back in time", () => {
  const clock = createUserTurnClock();
  clock.noteResponseStarted(30_000);
  assert.equal(clock.stamp(noMetrics, 30_300).getTime(), 30_000);
  // The same reply start must not stamp the next transcript.
  assert.equal(clock.stamp(noMetrics, 31_000).getTime(), 31_000);
  // A stale end of speech from before the previous row is not used.
  assert.equal(clock.stamp({ metrics: { stoppedSpeakingAt: 30.5 } }, 32_000).getTime(), 32_000);
});
