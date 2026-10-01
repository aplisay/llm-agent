import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { initializeLogger } from "@livekit/agents";
import { buildRealtimeLlmOptions } from "../lib/voice-session-factory.js";
import { RealtimeModel } from "../plugins/ultravox/src/realtime/realtime_model.js";
import { UltravoxClient } from "../plugins/ultravox/src/realtime/ultravox_client.js";

// Text-output mode: a final user transcript interrupts the external TTS, unless Ultravox
// already started its reply to that turn. On staging (2026-10-01) the user's final
// transcript arrived after the reply (agent ordinal 6, then user ordinal 5), so every
// reply was cancelled before the TTS spoke it.
// run: npx tsx --test test/ultravox-textout-barge-in.test.ts

initializeLogger({ pretty: false, level: process.env.TEST_LOG || "fatal" });

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const agent = { prompt: "You are a test agent.", options: { tts: { vendor: "cartesia" } }, functions: [] } as any;

const agentText = (ordinal: number, text: string) =>
  ({ type: "transcript", role: "agent", medium: "text", ordinal, text, delta: null, final: true });
const userVoice = (ordinal: number, text: string) =>
  ({ type: "transcript", role: "user", medium: "voice", ordinal, text, delta: null, final: true });
const state = (s: string) => ({ type: "state", state: s });

/** Replay `frames` to a text-output session through a stand-in Ultravox; count barge-ins it raises. */
async function bargeIns(t: TestContext, frames: object[]): Promise<number> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;
  t.mock.method(UltravoxClient.prototype, "createCall", async () => ({ callId: "uv-test", joinUrl: `ws://127.0.0.1:${port}/` }));
  t.mock.method(UltravoxClient.prototype, "deleteCall", async () => {});
  t.after(() => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });

  const options = buildRealtimeLlmOptions(ULTRAVOX, agent, "call-1");
  assert.deepEqual(options.modalities, ["text"], "the agent runs Ultravox in text-output mode");
  const model = new RealtimeModel({ ...options, apiKey: "test-key" } as any);
  const connected = once(wss, "connection") as Promise<[WebSocket]>;
  const session = model.session();
  const created = once(session as any, "session_created");
  let count = 0;
  session.on("input_speech_started", () => count++);
  // The session only connects once it has tools.
  await session.updateTools({
    lookup: { description: "lookup", parameters: { type: "object", properties: {} }, execute: async () => "{}" },
  } as any);
  const [socket] = await connected;
  await created;
  await new Promise((resolve) => setImmediate(resolve));

  for (const frame of frames) socket.send(JSON.stringify(frame));
  // A marker frame: once it is handled, every frame before it has been.
  const done = new Promise<void>((resolve) => session.on("input_audio_transcription_completed", (e: any) => e.transcript === "END" && resolve()));
  socket.send(JSON.stringify(userVoice(1000, "END")));
  await done;
  await session.close();
  return count - 1;
}

test("a user transcript that arrives after its reply started does not cancel the reply", async (t) => {
  // The staging sequence, in arrival order.
  const count = await bargeIns(t, [
    agentText(4, "Bonjour, comment allez-vous ?"),
    state("listening"),
    userVoice(3, "Hello ?"),
    agentText(6, "Je vais bien, merci."),
    state("listening"),
    userVoice(5, "Hi, how are you?"),
  ]);
  assert.equal(count, 0);
});

test("a user turn after the agent's latest turn still interrupts it", async (t) => {
  const count = await bargeIns(t, [
    agentText(2, "Bonjour, comment puis-je vous aider aujourd'hui ?"),
    state("listening"),
    userVoice(3, "Hello ?"),
  ]);
  assert.equal(count, 1);
});
