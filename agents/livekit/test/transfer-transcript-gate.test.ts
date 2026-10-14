import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTransferTranscriptGate,
  LATE_USER_TRANSCRIPT_MS,
} from "../lib/transfer-transcript-gate.js";

// While a transfer holds the caller's transcript, the turn that asked for the
// transfer must still be logged: Ultravox delivers the caller's final
// transcript after the transfer tool call (staging, 2026-10-14: 0.18 s after).
// run: npx tsx --test test/transfer-transcript-gate.test.ts

function setup() {
  let clock = 10_000;
  let inProgress = false;
  const gate = createTransferTranscriptGate({
    transferInProgress: () => inProgress,
    now: () => clock,
  });
  return {
    gate,
    at: (ms: number) => (clock = ms),
    startTransfer: () => {
      gate.noteTransferRequested();
      inProgress = true;
    },
    endTransfer: () => (inProgress = false),
  };
}

test("everything passes when no transfer is in progress", () => {
  const { gate } = setup();
  assert.equal(gate.allows({ role: "user" }), true);
  assert.equal(gate.allows({ role: "assistant", createdAt: 1 }), true);
});

test("the caller's transcript that arrives just after the transfer tool call is logged", () => {
  const { gate, at, startTransfer } = setup();
  at(20_000);
  startTransfer();
  at(20_181);
  assert.equal(gate.allows({ role: "user" }), true);
  at(20_000 + LATE_USER_TRANSCRIPT_MS);
  assert.equal(gate.allows({ role: "user" }), true);
});

test("the caller's speech later in the transfer stays held back", () => {
  const { gate, at, startTransfer } = setup();
  at(20_000);
  startTransfer();
  at(20_000 + LATE_USER_TRANSCRIPT_MS + 1);
  assert.equal(gate.allows({ role: "user" }), false);
});

test("agent speech that started before the transfer request is logged when its playout ends", () => {
  const { gate, at, startTransfer } = setup();
  at(20_000);
  startTransfer();
  at(22_500);
  assert.equal(gate.allows({ role: "assistant", createdAt: 19_200 }), true);
});

test("agent speech that started after the transfer request stays held back", () => {
  const { gate, at, startTransfer } = setup();
  at(20_000);
  startTransfer();
  at(20_400);
  assert.equal(gate.allows({ role: "assistant", createdAt: 20_100 }), false);
  assert.equal(gate.allows({ role: "assistant" }), false);
});

test("a transfer flag set without a transfer request holds everything back", () => {
  let inProgress = true;
  const gate = createTransferTranscriptGate({ transferInProgress: () => inProgress, now: () => 1 });
  assert.equal(gate.allows({ role: "user" }), false);
  assert.equal(gate.allows({ role: "assistant", createdAt: 0 }), false);
  inProgress = false;
  assert.equal(gate.allows({ role: "user" }), true);
});

test("the window follows the latest transfer request", () => {
  const { gate, at, startTransfer, endTransfer } = setup();
  at(20_000);
  startTransfer();
  endTransfer();
  at(60_000);
  startTransfer();
  at(60_200);
  assert.equal(gate.allows({ role: "user" }), true);
  assert.equal(gate.allows({ role: "assistant", createdAt: 30_000 }), true);
  assert.equal(gate.allows({ role: "assistant", createdAt: 60_100 }), false);
});
