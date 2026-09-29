import { test } from "node:test";
import assert from "node:assert/strict";
import { inference, initializeLogger } from "@livekit/agents";
import { requestedTtsSpeed, ttsSpeedFor } from "../lib/tts-speed.js";
import { buildPipelineTts, buildRealtimeLlmOptions } from "../lib/voice-session-factory.js";
import { buildNeuphonicTts } from "../lib/neuphonic-tts.js";
import { buildProviderPipelineTts } from "../lib/pipeline-provider-keys.js";
import { ultravoxSpeedOverrides } from "../plugins/ultravox/src/realtime/voice_speed.js";

// Portable options.tts.speed: the multiplier, its per-vendor clamp, and where each builder puts it.
// Mirrors agents/pipecat/tests/test_tts_speed.py.
// run: node --import tsx --test test/tts-speed.test.ts

initializeLogger({ pretty: false, level: "fatal" });

const makeAgent = (tts: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ prompt: "You are a test agent.", options: { tts, ...extra } }) as any;

test("unset, 1 and non-positive values send nothing", () => {
  for (const speed of [undefined, 1, 0, -1, "1.2", Number.NaN]) {
    assert.equal(requestedTtsSpeed(makeAgent({ speed })), undefined, String(speed));
  }
  assert.equal(requestedTtsSpeed(makeAgent({ speed: 1.2 })), 1.2);
});

test("clamped to the vendor range; unknown vendors get nothing", () => {
  assert.equal(ttsSpeedFor(makeAgent({ speed: 1.5 }), "elevenlabs"), 1.2);
  assert.equal(ttsSpeedFor(makeAgent({ speed: 0.5 }), "cartesia"), 0.6);
  assert.equal(ttsSpeedFor(makeAgent({ speed: 0.9 }), "openai"), 0.9);
  assert.equal(ttsSpeedFor(makeAgent({ speed: 1.2 }), "google"), undefined);
});

test("OpenAI realtime: speed on the model, clamped", () => {
  const opts = buildRealtimeLlmOptions("livekit:openai/gpt-realtime", makeAgent({ voice: "alloy", speed: 2 }), "c");
  assert.equal(opts.speed, 1.5);
  const plain = buildRealtimeLlmOptions("livekit:openai/gpt-realtime", makeAgent({ voice: "alloy" }), "c");
  assert.equal("speed" in plain, false);
});

test("OpenAI realtime in text-output mode: the speed belongs to the TTS", () => {
  const opts = buildRealtimeLlmOptions(
    "livekit:openai/gpt-realtime",
    makeAgent({ vendor: "elevenlabs", voice: "Rachel", speed: 1.1 }),
    "c",
  );
  assert.equal("speed" in opts, false);
});

test("Ultravox realtime: ttsSpeed unclamped, for the plugin to place by provider", () => {
  const opts = buildRealtimeLlmOptions("livekit:ultravox/ultravox-v0.7", makeAgent({ voice: "Mark", speed: 1.8 }), "c");
  assert.equal(opts.ttsSpeed, 1.8);
});

test("Ultravox voiceOverrides by provider", () => {
  assert.deepEqual(ultravoxSpeedOverrides("eleven_labs", 1.3)?.voiceOverrides, { elevenLabs: { speed: 1.2 } });
  assert.deepEqual(ultravoxSpeedOverrides("cartesia", 1.3)?.voiceOverrides, {
    cartesia: { generationConfig: { speed: 1.3 } },
  });
  assert.deepEqual(ultravoxSpeedOverrides("google", 1.3)?.voiceOverrides, { google: { speakingRate: 1.3 } });
  assert.deepEqual(ultravoxSpeedOverrides("inworld", 1.3)?.voiceOverrides, { inworld: { speakingRate: 1.3 } });
  assert.deepEqual(ultravoxSpeedOverrides("lmnt", 1.3)?.voiceOverrides, { lmnt: { speed: 1.3 } });
  assert.equal(ultravoxSpeedOverrides("respeecher", 1.3), undefined);
  assert.equal(ultravoxSpeedOverrides(undefined, 1.3), undefined);
});

test("Neuphonic: speed in the request options", () => {
  process.env.NEUPHONIC_API_KEY = "test";
  assert.equal(buildNeuphonicTts(makeAgent({ vendor: "neuphonic", speed: 1.5 })).options.speed, 1.5);
  assert.equal(buildNeuphonicTts(makeAgent({ vendor: "neuphonic" })).options.speed, undefined);
});

test("Inference Cartesia: a TTS object carrying modelOptions.speed; no speed keeps the string", () => {
  process.env.LIVEKIT_API_KEY = "k";
  process.env.LIVEKIT_API_SECRET = "s";
  const plain = buildPipelineTts(makeAgent({ vendor: "cartesia", voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc" }));
  assert.equal(plain, "cartesia/sonic-3:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc");
  const tts = buildPipelineTts(
    makeAgent({ vendor: "cartesia", voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc", speed: 1.2 }),
  ) as any;
  assert.ok(tts instanceof inference.TTS);
  assert.equal(tts.opts.modelOptions.speed, 1.2);
  assert.equal(tts.opts.model, "cartesia/sonic-3");
  assert.equal(tts.opts.voice, "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc");
});

test("Provider keys ElevenLabs: builds with a speed-only voiceSettings", () => {
  // The plugin keeps its options private, so this only checks the build accepts it.
  process.env.ELEVEN_API_KEY = "test";
  assert.ok(buildProviderPipelineTts(makeAgent({ vendor: "elevenlabs", voice: "abc", speed: 0.8 })));
});
