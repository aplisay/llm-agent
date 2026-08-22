import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackMessageFor } from "../lib/fallback-message.js";

// Unit tests for the LiveKit side of the fixed fallback message
// (`options.fallback.message`). Run with:
//   node --import tsx --test test/fallback-message.test.ts
//
// These pin the agent-options -> resolved-message mapping, which must stay in
// step with Pipecat's `fixed_message_for` (agents/pipecat/tests/
// test_fallback_message.py) — the two runtimes share one GCS cache, so a
// divergence here silently splits it rather than raising anything.

const agent = (options: unknown, modelName = "livekit:openai/gpt-4o-mini") =>
  ({ options, modelName }) as never;

/** A realtime speech-to-speech model — no discrete TTS of its own. */
const REALTIME = "livekit:ultravox/ultravox-v0.7";

test("returns null when no message is configured", () => {
  assert.equal(fallbackMessageFor(agent({})), null);
  assert.equal(fallbackMessageFor(agent({ fallback: {} })), null);
  assert.equal(fallbackMessageFor(agent({ fallback: { number: "+441234" } })), null);
});

test("text alone is the minimal form", () => {
  const resolved = fallbackMessageFor(
    agent({ fallback: { message: { text: "we are busy" } } }),
  );
  assert.equal(resolved?.text, "we are busy");
});

test("a bare string is rejected, not treated as shorthand", () => {
  // One shape to document, validate, and read. The write-time validation in
  // lib/database.js refuses a string outright, so this can only be reached by
  // data that bypassed it.
  assert.equal(fallbackMessageFor(agent({ fallback: { message: "we are busy" } })), null);
});

test("blank text resolves to null rather than an empty announcement", () => {
  assert.equal(fallbackMessageFor(agent({ fallback: { message: { text: "  " } } })), null);
  assert.equal(fallbackMessageFor(agent({ fallback: { message: {} } })), null);
});

test("unstated tts settings inherit from the agent's own voice", () => {
  const resolved = fallbackMessageFor(
    agent({
      tts: { vendor: "elevenlabs", voice: "Dominus", language: "en-GB" },
      fallback: { message: { text: "hi" } },
    }),
  );
  assert.deepEqual(resolved, {
    text: "hi",
    vendor: "elevenlabs",
    voice: "Dominus",
    language: "en-GB",
  });
});

test("stated tts settings win, so the announcement can name a healthy vendor", () => {
  // The point of the override: the agent's own TTS may be what just failed.
  const resolved = fallbackMessageFor(
    agent({
      tts: { vendor: "elevenlabs", voice: "Dominus", language: "en-GB" },
      fallback: { message: { text: "hi", vendor: "deepgram/aura-2", voice: "thalia" } },
    }),
  );
  assert.equal(resolved?.vendor, "deepgram/aura-2");
  assert.equal(resolved?.voice, "thalia");
  // Unstated fields still inherit.
  assert.equal(resolved?.language, "en-GB");
});

test("a realtime agent does not inherit the model's own voice", () => {
  // options.tts here names an Ultravox timbre, not a TTS voice. Inheriting it
  // would hand buildPipelineTts a vendor of "ultravox", which throws rather
  // than degrading — so the announcement covering Ultravox's failure would
  // itself fail. Language still comes through: it is portable.
  const resolved = fallbackMessageFor(
    agent(
      {
        tts: { vendor: "ultravox", voice: "Svetlana", language: "en-GB" },
        fallback: { message: { text: "we are busy" } },
      },
      REALTIME,
    ),
  );
  assert.equal(resolved?.vendor, undefined);
  assert.equal(resolved?.voice, undefined);
  assert.equal(resolved?.language, "en-GB");
});

test("a realtime agent keeps an explicit TTS override", () => {
  // The configuration that makes the feature usable at all for Ultravox.
  const resolved = fallbackMessageFor(
    agent(
      {
        tts: { vendor: "ultravox", voice: "Svetlana", language: "en-GB" },
        fallback: {
          message: { text: "we are busy", vendor: "elevenlabs", voice: "Rachel" },
        },
      },
      REALTIME,
    ),
  );
  assert.equal(resolved?.vendor, "elevenlabs");
  assert.equal(resolved?.voice, "Rachel");
});

test("options.voiceMode override is honoured when deciding inheritance", () => {
  // Forcing pipeline mode means options.tts really does describe a TTS.
  const resolved = fallbackMessageFor(
    agent(
      {
        voiceMode: "pipeline",
        tts: { vendor: "elevenlabs", voice: "Rachel" },
        fallback: { message: { text: "we are busy" } },
      },
      REALTIME,
    ),
  );
  assert.equal(resolved?.vendor, "elevenlabs");
  assert.equal(resolved?.voice, "Rachel");
});
