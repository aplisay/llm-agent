import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRealtimeLlmOptions,
  inactivityAwayTimeoutSecs,
  inactivityHangupEnabled,
  INACTIVITY_PROMPT_COUNT,
} from "../lib/voice-session-factory.js";

// Covers `options.inactivity.hangup`: end the call once the inactivity prompt has gone
// unanswered INACTIVITY_PROMPT_COUNT times, instead of prompting forever. Without it a
// leg nobody hangs up is only reclaimed by the model's maxDuration long-stop, which can
// leave a caller (or an abandoned transfer target) on silence for minutes.
// This file covers the option gate and the Ultravox native mapping; the generic
// (non-Ultravox) counter lives in voice-agent-runtime.
// run: npx tsx --test test/inactivity-hangup.test.ts

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const OPENAI = "livekit:openai/gpt-4o-realtime";

const makeAgent = (options: Record<string, unknown> = {}) =>
  ({ prompt: "You are a test agent.", options }) as any;

const withInactivity = (extra: Record<string, unknown> = {}) =>
  makeAgent({ inactivity: { timeout: "6s", message: "Are you still there?", ...extra } });

const ultravoxMessages = (agent: any) =>
  (buildRealtimeLlmOptions(ULTRAVOX, agent, "call-1").vendorSpecific as any)?.ultravox
    ?.inactivityMessages;

// --- the option gate ---------------------------------------------------------

test("hangup defaults off", () => {
  assert.equal(inactivityHangupEnabled(withInactivity()), false);
  assert.equal(inactivityHangupEnabled(withInactivity({ hangup: false })), false);
});

test("hangup on when explicitly set", () => {
  assert.equal(inactivityHangupEnabled(withInactivity({ hangup: true })), true);
});

test("hangup requires a usable inactivity config", () => {
  // No prompt to count means nothing to hang up after.
  assert.equal(inactivityHangupEnabled(makeAgent({})), false);
  assert.equal(
    inactivityHangupEnabled(makeAgent({ inactivity: { hangup: true } })),
    false,
  );
  assert.equal(
    inactivityHangupEnabled(makeAgent({ inactivity: { hangup: true, timeout: "6s" } })),
    false,
    "message missing",
  );
  assert.equal(
    inactivityHangupEnabled(
      makeAgent({ inactivity: { hangup: true, message: "hi", timeout: "0s" } }),
    ),
    false,
    "non-positive timeout",
  );
  // Sanity: the gate agrees with the timeout parser it defers to.
  assert.equal(inactivityAwayTimeoutSecs(makeAgent({ inactivity: { hangup: true } })), undefined);
});

test("truthy-but-not-true does not opt in", () => {
  assert.equal(inactivityHangupEnabled(withInactivity({ hangup: "yes" })), false);
  assert.equal(inactivityHangupEnabled(withInactivity({ hangup: 1 })), false);
});

// --- Ultravox native mapping -------------------------------------------------

test("without hangup: N prompts, no endBehavior anywhere (unchanged behaviour)", () => {
  const messages = ultravoxMessages(withInactivity());
  assert.equal(messages.length, INACTIVITY_PROMPT_COUNT);
  for (const m of messages) {
    assert.deepEqual(m, { duration: "6s", message: "Are you still there?" });
    assert.equal(m.endBehavior, undefined);
  }
});

test("with hangup: endBehavior on the LAST prompt only", () => {
  const messages = ultravoxMessages(withInactivity({ hangup: true }));
  assert.equal(messages.length, INACTIVITY_PROMPT_COUNT);

  for (const m of messages.slice(0, -1)) {
    assert.equal(m.endBehavior, undefined, "earlier prompts must not end the call");
  }
  assert.deepEqual(messages[messages.length - 1], {
    duration: "6s",
    message: "Are you still there?",
    endBehavior: "END_BEHAVIOR_HANG_UP_SOFT",
  });
});

test("SOFT not STRICT, so the final prompt is still delivered", () => {
  const last = ultravoxMessages(withInactivity({ hangup: true })).at(-1);
  assert.equal(last.endBehavior, "END_BEHAVIOR_HANG_UP_SOFT");
});

test("caller-supplied native inactivityMessages still win outright", () => {
  const native = [{ duration: "30s", message: "native", endBehavior: "END_BEHAVIOR_UNSPECIFIED" }];
  const agent = makeAgent({
    inactivity: { timeout: "6s", message: "Are you still there?", hangup: true },
    vendorSpecific: { ultravox: { inactivityMessages: native } },
  });
  assert.deepEqual(ultravoxMessages(agent), native);
});

test("prompt entries are independent objects, not shared references", () => {
  // The mapping builds copies; a caller mutating one must not affect the others.
  const messages = ultravoxMessages(withInactivity({ hangup: true }));
  messages[0].message = "mutated";
  assert.equal(messages[1].message, "Are you still there?");
});

test("non-ultravox models get no native inactivityMessages", () => {
  // Enforcement for these lives in voice-agent-runtime's counter instead.
  const opts = buildRealtimeLlmOptions(OPENAI, withInactivity({ hangup: true }), "call-1");
  assert.equal((opts.vendorSpecific as any)?.ultravox?.inactivityMessages, undefined);
});
