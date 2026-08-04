import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRealtimeLlmOptions } from "../lib/voice-session-factory.js";

// Covers the portable-option → RealtimeModel options mapping for realtime models:
// maxDuration/timeExceededMessage passthrough and the Ultravox-specific
// greeting/inactivity → vendorSpecific translations with their precedence rules.
// run: node --import tsx --test test/voice-session-factory.test.ts

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const OPENAI = "livekit:openai/gpt-4o-realtime";

const makeAgent = (options: Record<string, unknown> = {}) =>
  ({ prompt: "You are a test agent.", options }) as any;

test("basic shape: model, voice, instructions, callId and defaults", () => {
  const opts = buildRealtimeLlmOptions(ULTRAVOX, makeAgent({ tts: { voice: "Mark" } }), "call-1");
  assert.equal(opts.model, "ultravox-v0.7");
  assert.equal(opts.voice, "Mark");
  assert.equal(opts.instructions, "You are a test agent.");
  assert.equal(opts.callId, "call-1");
  assert.equal(opts.maxDuration, "305s");
  assert.equal(opts.timeExceededMessage, undefined);
  assert.equal(opts.vendorSpecific, undefined);
});

test("custom maxDuration and timeExceededMessage pass through to the plugin", () => {
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({ maxDuration: "120s", timeExceededMessage: "Time is up, goodbye!" }),
    "call-1",
  );
  assert.equal(opts.maxDuration, "120s");
  assert.equal(opts.timeExceededMessage, "Time is up, goodbye!");
});

test("empty timeExceededMessage falls back to the plugin default (undefined)", () => {
  const opts = buildRealtimeLlmOptions(ULTRAVOX, makeAgent({ timeExceededMessage: "" }), "call-1");
  assert.equal(opts.timeExceededMessage, undefined);
});

test("timeExceededMessage is passed for non-ultravox realtime too (ignored there)", () => {
  const opts = buildRealtimeLlmOptions(
    OPENAI,
    makeAgent({ timeExceededMessage: "Time is up!" }),
    "call-1",
  );
  assert.equal(opts.timeExceededMessage, "Time is up!");
});

test("ultravox: portable greeting.text maps to uninterruptible firstSpeakerSettings", () => {
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({ greeting: { text: "Hello, how can I help?" } }),
    "call-1",
  ) as any;
  assert.deepEqual(opts.vendorSpecific.ultravox.firstSpeakerSettings, {
    agent: { uninterruptible: true, text: "Hello, how can I help?" },
  });
});

test("ultravox: portable greeting.instructions maps to an uninterruptible prompt", () => {
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({ greeting: { instructions: "Greet the caller briefly." } }),
    "call-1",
  ) as any;
  assert.deepEqual(opts.vendorSpecific.ultravox.firstSpeakerSettings, {
    agent: { uninterruptible: true, prompt: "Greet the caller briefly." },
  });
});

test("ultravox: caller-supplied firstSpeakerSettings win over the portable greeting", () => {
  const native = { agent: { text: "Native greeting" } };
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({
      greeting: { text: "Portable greeting" },
      vendorSpecific: { ultravox: { firstSpeakerSettings: native } },
    }),
    "call-1",
  ) as any;
  assert.deepEqual(opts.vendorSpecific.ultravox.firstSpeakerSettings, native);
});

test("ultravox: portable inactivity maps to three repeated inactivityMessages", () => {
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({ inactivity: { timeout: "30s", message: "Are you still there?" } }),
    "call-1",
  ) as any;
  const entry = { duration: "30s", message: "Are you still there?" };
  assert.deepEqual(opts.vendorSpecific.ultravox.inactivityMessages, [entry, entry, entry]);
});

test("ultravox: caller-supplied inactivityMessages win over portable inactivity", () => {
  const native = [{ duration: "45s", message: "Native nudge" }];
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({
      inactivity: { timeout: "30s", message: "Portable nudge" },
      vendorSpecific: { ultravox: { inactivityMessages: native } },
    }),
    "call-1",
  ) as any;
  assert.deepEqual(opts.vendorSpecific.ultravox.inactivityMessages, native);
});

test("ultravox: greeting and inactivity merge into one vendorSpecific block", () => {
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({
      greeting: { text: "Hello!" },
      inactivity: { timeout: 20, message: "Hello?" },
    }),
    "call-1",
  ) as any;
  assert.deepEqual(opts.vendorSpecific.ultravox.firstSpeakerSettings, {
    agent: { uninterruptible: true, text: "Hello!" },
  });
  assert.deepEqual(opts.vendorSpecific.ultravox.inactivityMessages[0], {
    duration: "20s",
    message: "Hello?",
  });
});

test("non-ultravox: greeting/inactivity are not mapped, vendorSpecific passes through verbatim", () => {
  const vendorSpecific = { openai: { something: true } };
  const opts = buildRealtimeLlmOptions(
    OPENAI,
    makeAgent({
      greeting: { text: "Hello!" },
      inactivity: { timeout: "30s", message: "Hello?" },
      vendorSpecific,
    }),
    "call-1",
  ) as any;
  assert.equal(opts.vendorSpecific, vendorSpecific);
  assert.equal(opts.vendorSpecific.ultravox, undefined);
});

test("tts.language maps to the Ultravox languageHint, keeping the region subtag", () => {
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({ tts: { voice: "Mark", language: "en-GB" } }),
    "call-1",
  );
  assert.equal(opts.languageHint, "en-GB");
});

test("languageHint falls back to stt.language when tts.language is unset", () => {
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({ stt: { language: "fr-FR" } }),
    "call-1",
  );
  assert.equal(opts.languageHint, "fr-FR");
});

test("tts.language wins over stt.language for the languageHint", () => {
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({ tts: { language: "de-DE" }, stt: { language: "fr-FR" } }),
    "call-1",
  );
  assert.equal(opts.languageHint, "de-DE");
});

test("no language options leaves languageHint unset (Ultravox auto-detects)", () => {
  const opts = buildRealtimeLlmOptions(ULTRAVOX, makeAgent({ tts: { voice: "Mark" } }), "call-1");
  assert.equal(opts.languageHint, undefined);
});

test("non-specific language sentinels do not produce a languageHint", () => {
  for (const language of ["any", "multi", "auto", "*", "ALL", "  "]) {
    const opts = buildRealtimeLlmOptions(ULTRAVOX, makeAgent({ tts: { language } }), "call-1");
    assert.equal(opts.languageHint, undefined, `expected no hint for ${JSON.stringify(language)}`);
  }
});

test("non-ultravox realtime gets no languageHint", () => {
  const opts = buildRealtimeLlmOptions(OPENAI, makeAgent({ tts: { language: "en-GB" } }), "call-1");
  assert.equal(opts.languageHint, undefined);
});
