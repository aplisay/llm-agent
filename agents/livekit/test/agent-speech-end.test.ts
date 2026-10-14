import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { waitForAgentSpeechToEnd } from "../lib/utils.js";

// waitForAgentSpeechToEnd holds an accepted warm transfer until the consult
// agent has stopped speaking, so the target is not cut off mid-question.
// run: npx tsx --test test/agent-speech-end.test.ts

class FakeSession extends EventEmitter {
  constructor(public agentState: string) {
    super();
  }
  setState(newState: string) {
    this.agentState = newState;
    this.emit("agent_state_changed", { newState });
  }
}

type StateSource = Parameters<typeof waitForAgentSpeechToEnd>[0];
const asSource = (s: FakeSession) => s as unknown as StateSource;

const QUIET = 1_000;
const CAP = 20_000;

function track(promise: Promise<string>) {
  const state: { outcome?: string } = {};
  promise.then((o) => {
    state.outcome = o;
  });
  return state;
}

// Let a promise settled by a mock timer run its then() before asserting.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("not speaking: resolves after the quiet window, not before", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new FakeSession("listening");
  const result = track(waitForAgentSpeechToEnd(asSource(session), QUIET, CAP));
  t.mock.timers.tick(QUIET - 1);
  await flush();
  assert.equal(result.outcome, undefined);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(result.outcome, "quiet");
  assert.equal(session.listenerCount("agent_state_changed"), 0);
});

test("speaking: waits for the speech to end, then the quiet window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new FakeSession("speaking");
  const result = track(waitForAgentSpeechToEnd(asSource(session), QUIET, CAP));
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(result.outcome, undefined);
  session.setState("listening");
  t.mock.timers.tick(QUIET - 1);
  await flush();
  assert.equal(result.outcome, undefined);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(result.outcome, "quiet");
});

test("speech that starts inside the quiet window is waited for too", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The tool ran before the turn's first audio frame played.
  const session = new FakeSession("thinking");
  const result = track(waitForAgentSpeechToEnd(asSource(session), QUIET, CAP));
  t.mock.timers.tick(500);
  session.setState("speaking");
  t.mock.timers.tick(4_000);
  await flush();
  assert.equal(result.outcome, undefined);
  session.setState("listening");
  t.mock.timers.tick(QUIET);
  await flush();
  assert.equal(result.outcome, "quiet");
});

test("never stops speaking: gives up at the cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new FakeSession("speaking");
  const result = track(waitForAgentSpeechToEnd(asSource(session), QUIET, CAP));
  t.mock.timers.tick(CAP - 1);
  await flush();
  assert.equal(result.outcome, undefined);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(result.outcome, "cap");
  assert.equal(session.listenerCount("agent_state_changed"), 0);
});
