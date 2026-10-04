import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { inference, initializeLogger } from "@livekit/agents";
import type { TTS as CartesiaTTS } from "@livekit/agents-plugin-cartesia";

// The language each Cartesia TTS path sends, so a catalogue voice in another language is not driven as English.
// run: node --import tsx --test test/cartesia-language.test.ts

initializeLogger({ pretty: false, level: "fatal" });

// The Cartesia plugin reads CARTESIA_API_KEY when first imported, so set it before loading the builders.
process.env.CARTESIA_API_KEY ||= "test";
process.env.LIVEKIT_API_KEY ||= "k";
process.env.LIVEKIT_API_SECRET ||= "s";
const { buildPipelineTts } = await import("../lib/voice-session-factory.js");
const { buildProviderPipelineTts } = await import("../lib/pipeline-provider-keys.js");

const VOICE = "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";
const makeAgent = (tts: Record<string, unknown> = {}, stt?: Record<string, unknown>) =>
  ({ prompt: "You are a test agent.", options: { tts: { vendor: "cartesia", voice: VOICE, ...tts }, ...(stt ? { stt } : {}) } }) as any;

test("Inference: the agent's language as a base code, with or without a speed", () => {
  const french = buildPipelineTts(makeAgent({ language: "fr-CA" })) as any;
  assert.ok(french instanceof inference.TTS);
  assert.equal(french.opts.model, "cartesia/sonic-3");
  assert.equal(french.opts.voice, VOICE);
  assert.equal(french.opts.language, "fr");
  assert.equal(french.opts.modelOptions?.speed, undefined);

  const hindiFast = buildPipelineTts(makeAgent({ speed: 1.2 }, { language: "hi-IN" })) as any;
  assert.equal(hindiFast.opts.language, "hi");
  assert.equal(hindiFast.opts.modelOptions.speed, 1.2);
});

test("Inference: no language and no speed keeps the plain model string", () => {
  assert.equal(buildPipelineTts(makeAgent()), `cartesia/sonic-3:${VOICE}`);
  assert.equal(buildPipelineTts(makeAgent({ language: "multi" })), `cartesia/sonic-3:${VOICE}`);
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
  stream.pushText("Hello from the language test.");
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

test("Provider keys: every sonic-3 language passes through; others fall back to English", async () => {
  assert.equal((await firstCartesiaMessage(makeAgent({ language: "hi-IN" }))).language, "hi");
  assert.equal((await firstCartesiaMessage(makeAgent({ language: "it-IT" }))).language, "it");
  assert.equal((await firstCartesiaMessage(makeAgent({ language: "ur-IN" }))).language, "en");
});
