import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRealtimeLlmOptions } from "../lib/voice-session-factory.js";
import { HANDOVER_OPENING_INSTRUCTION } from "../lib/handover-opening.js";

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
  // The platform's default interruption threshold is the only vendorSpecific
  // content when the agent supplies none (see ultravox-vad-default.test.ts).
  assert.deepEqual(opts.vendorSpecific, {
    ultravox: { vadSettings: { minimumInterruptionDuration: "0.48s" } },
  });
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


// --- text-output mode (external TTS) -------------------------------------------
// docs/realtime-external-tts.md: a TTS vendor other than the model's own makes the
// model emit text only; options.tts.voice then names the TTS voice, never the
// model's, so it must not reach the plugin.

test("ultravox: an external TTS vendor switches the model to text-only output with no voice", () => {
  const opts = buildRealtimeLlmOptions(
    ULTRAVOX,
    makeAgent({ tts: { vendor: "deepgram", voice: "aura-athena-en", language: "en-GB" } }),
    "call-1",
  ) as any;
  assert.deepEqual(opts.modalities, ["text"]);
  assert.equal(opts.voice, undefined);
  // The language still guides Ultravox's own recognition.
  assert.equal(opts.languageHint, "en-GB");
});

test("ultravox: the model's own vendor keeps its voice and its audio", () => {
  const opts = buildRealtimeLlmOptions(ULTRAVOX, makeAgent({ tts: { vendor: "ultravox", voice: "Mark" } }), "call-1") as any;
  assert.equal(opts.modalities, undefined);
  assert.equal(opts.voice, "Mark");
});

test("openai realtime: an external TTS vendor switches the model to text-only output", () => {
  const opts = buildRealtimeLlmOptions(
    "livekit:openai/gpt-realtime",
    makeAgent({ tts: { vendor: "elevenlabs", voice: "Rachel" } }),
    "call-1",
  ) as any;
  assert.deepEqual(opts.modalities, ["text"]);
  assert.equal(opts.voice, undefined);
});

test("gemini: an external vendor is not honoured (no text-capable Live model), voice passes through", () => {
  const opts = buildRealtimeLlmOptions(
    "livekit:google/gemini-2.0-flash-exp",
    makeAgent({ tts: { vendor: "elevenlabs", voice: "Kore" } }),
    "call-1",
  ) as any;
  assert.equal(opts.modalities, undefined);
  assert.equal(opts.voice, "Kore");
});

// --- handover legs ---------------------------------------------------------------
// The first session after a transfer_agent full-stack handover. The caller was
// greeted when the call started, so on Ultravox the opening is the handover
// instruction, never the incoming agent's greeting (lib/handover-opening.ts).

const HANDOVER_OPENING = { agent: { prompt: HANDOVER_OPENING_INSTRUCTION } };

const handoverLeg = (modelName: string, agent: any) =>
  buildRealtimeLlmOptions(modelName, agent, "call-2", { handover: true }) as any;

test("first legs are unchanged: handover defaults to false", () => {
  const agent = makeAgent({ greeting: { text: "Hello!" } });
  assert.deepEqual(
    buildRealtimeLlmOptions(ULTRAVOX, agent, "call-1", { handover: false }),
    buildRealtimeLlmOptions(ULTRAVOX, agent, "call-1"),
  );
});

test("ultravox handover leg: opens from the handover instruction when the agent has no greeting", () => {
  assert.deepEqual(
    handoverLeg(ULTRAVOX, makeAgent()).vendorSpecific.ultravox.firstSpeakerSettings,
    HANDOVER_OPENING,
  );
});

test("ultravox handover leg: the portable greeting is not used", () => {
  for (const greeting of [{ text: "Hello, how can I help?" }, { instructions: "Greet the caller briefly." }]) {
    assert.deepEqual(
      handoverLeg(ULTRAVOX, makeAgent({ greeting })).vendorSpecific.ultravox.firstSpeakerSettings,
      HANDOVER_OPENING,
      `greeting ${JSON.stringify(greeting)} must not open a handover leg`,
    );
  }
});

test("ultravox handover leg: caller-supplied firstSpeakerSettings are replaced, not merged", () => {
  const natives = [
    { agent: { text: "Native greeting", uninterruptible: true } },
    { user: { fallback: { delay: "3s", prompt: "Say hello." } } },
  ];
  for (const native of natives) {
    const agent = makeAgent({ vendorSpecific: { ultravox: { firstSpeakerSettings: native } } });
    assert.deepEqual(
      handoverLeg(ULTRAVOX, agent).vendorSpecific.ultravox.firstSpeakerSettings,
      HANDOVER_OPENING,
    );
    // The agent's own options are left as they were.
    assert.deepEqual(agent.options.vendorSpecific.ultravox.firstSpeakerSettings, native);
  }
});

test("ultravox handover leg: the other Ultravox mappings still apply", () => {
  const opts = handoverLeg(
    ULTRAVOX,
    makeAgent({
      greeting: { text: "Hello!" },
      inactivity: { timeout: "20s", message: "Hello?" },
      tts: { voice: "Mark", language: "en-GB" },
      vendorSpecific: { ultravox: { experimentalSettings: { transcriptionProvider: "deepgram-nova-3" } } },
    }),
  );
  const ultravox = opts.vendorSpecific.ultravox;
  assert.deepEqual(ultravox.firstSpeakerSettings, HANDOVER_OPENING);
  assert.equal(ultravox.inactivityMessages.length, 3);
  assert.deepEqual(ultravox.vadSettings, { minimumInterruptionDuration: "0.48s" });
  assert.deepEqual(ultravox.experimentalSettings, { transcriptionProvider: "deepgram-nova-3" });
  assert.equal(opts.voice, "Mark");
  assert.equal(opts.languageHint, "en-GB");
});

test("non-ultravox realtime: the options are the same on a handover leg (the runtime asks for the opening)", () => {
  const agent = makeAgent({ greeting: { text: "Hello!" }, vendorSpecific: { openai: { something: true } } });
  assert.deepEqual(handoverLeg(OPENAI, agent), buildRealtimeLlmOptions(OPENAI, agent, "call-2"));
});
