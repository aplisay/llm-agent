import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { inference, initializeLogger } from "@livekit/agents";
import type { TTS as CartesiaTTS } from "@livekit/agents-plugin-cartesia";
import { deepgramTtsSpeed, requestedTtsSpeed, ttsSpeedFor } from "../lib/tts-speed.js";
import { buildNeuphonicTts } from "../lib/neuphonic-tts.js";
import { ultravoxSpeedOverrides } from "../plugins/ultravox/src/realtime/voice_speed.js";

// Portable options.tts.speed: the multiplier, its per-vendor clamp, and where each builder puts it.
// Mirrors agents/pipecat/tests/test_tts_speed.py.
// run: node --import tsx --test test/tts-speed.test.ts

initializeLogger({ pretty: false, level: "fatal" });

// The Cartesia plugin reads CARTESIA_API_KEY when first imported, so set it before loading the builders.
process.env.CARTESIA_API_KEY ||= "test";
const { buildPipelineTts, buildRealtimeLlmOptions } = await import("../lib/voice-session-factory.js");
const { buildProviderPipelineTts } = await import("../lib/pipeline-provider-keys.js");

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

test("Deepgram: clamped on Aura-2 English and Spanish voices, none on other models", () => {
  assert.equal(deepgramTtsSpeed(makeAgent({ speed: 2 }), "aura-2-thalia-en"), 1.5);
  assert.equal(deepgramTtsSpeed(makeAgent({ speed: 0.5 }), "aura-2-celeste-es"), 0.7);
  assert.equal(deepgramTtsSpeed(makeAgent(), "aura-2-thalia-en"), undefined);
  // Deepgram answers 400 to any speed on these.
  assert.equal(deepgramTtsSpeed(makeAgent({ speed: 1.2 }), "aura-asteria-en"), undefined);
  assert.equal(deepgramTtsSpeed(makeAgent({ speed: 1.2 }), "aura-2-julius-de"), undefined);
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

/** The first message the Cartesia plugin streams for `agent`, sent to a local stand-in for Cartesia. */
async function firstCartesiaMessage(agent: unknown): Promise<Record<string, unknown>> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const message = new Promise<Record<string, unknown>>((resolve) =>
    wss.once("connection", (ws) => ws.once("message", (data) => resolve(JSON.parse(String(data))))),
  );
  const tts = buildProviderPipelineTts(agent as any) as CartesiaTTS;
  tts.updateOptions({ baseUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}` });
  const stream = tts.stream();
  stream.pushText("Hello from the speed test, spoken at the requested rate.");
  stream.flush();
  try {
    return await message;
  } finally {
    stream.close();
    await tts.close();
    for (const client of wss.clients) client.terminate();
    wss.close();
  }
}

test("Provider keys Cartesia: speed in generation_config, clamped", async () => {
  // The plugin keeps its options private, so check what it sends.
  const voice = "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";
  const fast = await firstCartesiaMessage(makeAgent({ vendor: "cartesia", voice, speed: 1.8 }));
  assert.deepEqual(fast.generation_config, { speed: 1.5 });
  const plain = await firstCartesiaMessage(makeAgent({ vendor: "cartesia", voice }));
  assert.equal("generation_config" in plain, false);
});

test("Provider keys Deepgram: clamped speed on Aura-2 English and Spanish, none elsewhere", () => {
  process.env.DEEPGRAM_API_KEY = "test";
  const built = (voice: string, speed?: number) => {
    const { opts } = buildProviderPipelineTts(makeAgent({ vendor: "deepgram", voice, speed })) as any;
    return { model: opts.model, speed: opts.speed };
  };
  // The plugin throws outside 0.7 to 1.5, so an unclamped speed would fail the build.
  assert.deepEqual(built("aura-2-thalia-en", 1.8), { model: "aura-2-thalia-en", speed: 1.5 });
  assert.deepEqual(built("aura-2-celeste-es", 0.5), { model: "aura-2-celeste-es", speed: 0.7 });
  assert.deepEqual(built("aura-2-thalia-en"), { model: "aura-2-thalia-en", speed: undefined });
  // Catalogue voices build Aura-1 models, which refuse any speed.
  assert.deepEqual(built("aura-asteria-en", 1.2), { model: "aura-asteria-en", speed: undefined });
  assert.deepEqual(built("aura-2-julius-de", 1.2), { model: "aura-2-julius-de", speed: undefined });
});
