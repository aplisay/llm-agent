import { test } from "node:test";
import assert from "node:assert/strict";
import { externalTtsVendor, textOutputEnabled, ttsVendor } from "../lib/realtime-tts.js";

// The text-output rule (docs/realtime-external-tts.md): on a realtime model,
// options.tts.vendor set to a vendor other than the model's own provider means the
// model emits text and the session's TTS speaks it. Mirrors
// agents/pipecat/tests/test_realtime_external_tts.py for the other worker.
// run: node --import tsx --test test/realtime-tts.test.ts

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const OPENAI = "livekit:openai/gpt-realtime";
const GEMINI = "livekit:google/gemini-2.0-flash-exp";

const agent = (tts?: Record<string, unknown>) => ({ prompt: "p", options: tts ? { tts } : {} }) as any;

test("unset or blank vendors keep the model's own voice", () => {
  assert.equal(ttsVendor(agent()), undefined);
  assert.equal(ttsVendor(agent({ vendor: "   " })), undefined);
  assert.equal(externalTtsVendor(agent({ voice: "Mark" }), ULTRAVOX), undefined);
});

test("the provider's own vendor is native", () => {
  assert.equal(externalTtsVendor(agent({ vendor: "ultravox" }), ULTRAVOX), undefined);
  assert.equal(externalTtsVendor(agent({ vendor: "openai" }), OPENAI), undefined);
  // google is a TTS vendor too, but on a Gemini row it is the model's own voice.
  assert.equal(externalTtsVendor(agent({ vendor: "google" }), GEMINI), undefined);
});

test("any other vendor is external, with scoping and case ignored", () => {
  assert.equal(externalTtsVendor(agent({ vendor: "elevenlabs" }), ULTRAVOX), "elevenlabs");
  assert.equal(externalTtsVendor(agent({ vendor: "ElevenLabs/eleven_flash_v2_5" }), ULTRAVOX), "elevenlabs");
  assert.equal(externalTtsVendor(agent({ vendor: "google" }), ULTRAVOX), "google");
  assert.equal(externalTtsVendor(agent({ vendor: "Ultravox" }), ULTRAVOX), undefined);
});

test("text output only where this worker supports it", () => {
  const ext = agent({ vendor: "deepgram", voice: "aura-athena-en" });
  assert.equal(textOutputEnabled(ext, ULTRAVOX), true);
  assert.equal(textOutputEnabled(ext, OPENAI), true);
  // No Gemini Live model the API still serves accepts a TEXT modality.
  assert.equal(textOutputEnabled(ext, GEMINI), false);
  assert.equal(textOutputEnabled(agent({ vendor: "ultravox" }), ULTRAVOX), false);
  // A pipeline row's TTS is always discrete; the rule never applies there.
  assert.equal(textOutputEnabled(ext, "livekit:openai/gpt-4o-mini"), false);
});
