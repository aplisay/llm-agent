import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { AsyncIterableQueue, VADEventType, initializeLogger } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { buildRealtimeLlmOptions, ultravoxBargeInMinSpeechMs } from "../lib/voice-session-factory.js";
import { RealtimeModel } from "../plugins/ultravox/src/realtime/realtime_model.js";
import { UltravoxClient } from "../plugins/ultravox/src/realtime/ultravox_client.js";

// Text-output mode: a local VAD on the caller's audio interrupts the external TTS. Without
// one, a final user transcript does, unless Ultravox already started its reply to that turn.
// On staging (2026-10-01) the user's final transcript arrived after the reply (agent ordinal
// 6, then user ordinal 5), so every reply was cancelled before the TTS spoke it, and once
// that was fixed the agent never yielded to a caller who spoke over it.
// run: npx tsx --test test/ultravox-textout-barge-in.test.ts

initializeLogger({ pretty: false, level: process.env.TEST_LOG || "fatal" });

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const agent = { prompt: "You are a test agent.", options: { tts: { vendor: "cartesia" } }, functions: [] } as any;

const agentText = (ordinal: number, text: string) =>
  ({ type: "transcript", role: "agent", medium: "text", ordinal, text, delta: null, final: true });
const userVoice = (ordinal: number, text: string) =>
  ({ type: "transcript", role: "user", medium: "voice", ordinal, text, delta: null, final: true });
const state = (s: string) => ({ type: "state", state: s });

/** A stand-in VAD whose events the test raises by hand. */
class FakeVad {
  frames = 0;
  closed = false;
  events = new AsyncIterableQueue<any>();
  stream() {
    const vad = this;
    return {
      pushFrame: () => void vad.frames++,
      close: () => { vad.closed = true; vad.events.close(); },
      [Symbol.asyncIterator]: () => vad.events[Symbol.asyncIterator](),
    };
  }
  raise(type: VADEventType) {
    this.events.put({ type, speechDuration: 500 });
  }
}

/** A text-output session joined to a stand-in Ultravox. Records the speech events it raises. */
async function textOutputSession(t: TestContext, localVad?: FakeVad) {
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
  const model = new RealtimeModel({ ...options, ...(localVad ? { localVad } : {}), apiKey: "test-key" } as any);
  const connected = once(wss, "connection") as Promise<[WebSocket]>;
  const session = model.session();
  const created = once(session as any, "session_created");
  const events: string[] = [];
  session.on("input_speech_started", () => events.push("started"));
  session.on("input_speech_stopped", () => events.push("stopped"));
  // The session only connects once it has tools.
  await session.updateTools({
    lookup: { description: "lookup", parameters: { type: "object", properties: {} }, execute: async () => "{}" },
  } as any);
  const [socket] = await connected;
  await created;
  await new Promise((resolve) => setImmediate(resolve));

  /** Send `frames`, then wait until the session has handled them all. */
  const replay = async (frames: object[]) => {
    for (const frame of frames) socket.send(JSON.stringify(frame));
    const marker = `END-${Math.random()}`;
    await new Promise<void>((resolve) => {
      const onDone = (e: any) => {
        if (e.transcript !== marker) return;
        session.off("input_audio_transcription_completed", onDone);
        resolve();
      };
      session.on("input_audio_transcription_completed", onDone);
      socket.send(JSON.stringify(userVoice(1000, marker)));
    });
  };
  return { session, events, replay };
}

/** Replay `frames` to a text-output session with no local VAD; count the barge-ins it raises. */
async function bargeIns(t: TestContext, frames: object[]): Promise<number> {
  const { session, events, replay } = await textOutputSession(t);
  await replay(frames);
  await session.close();
  // The end marker is itself a new user turn, so it raises one.
  return events.filter((e) => e === "started").length - 1;
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

test("without a local VAD, the transcript fallback marks the caller as stopped again", async (t) => {
  const { session, events, replay } = await textOutputSession(t);
  await replay([agentText(2, "Bonjour."), state("listening"), userVoice(3, "Hello ?")]);
  await session.close();
  assert.deepEqual(events.slice(0, 2), ["started", "stopped"]);
});

test("with a local VAD, the caller's speech interrupts and transcripts do not", async (t) => {
  const vad = new FakeVad();
  const { session, events, replay } = await textOutputSession(t, vad);

  session.pushAudio(new AudioFrame(new Int16Array(160), 8000, 1, 160));
  assert.equal(vad.frames, 1, "the caller's audio reaches the VAD");

  vad.raise(VADEventType.INFERENCE_DONE);
  vad.raise(VADEventType.START_OF_SPEECH);
  vad.raise(VADEventType.END_OF_SPEECH);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["started", "stopped"]);

  // A user turn the agent has not answered yet: the VAD already raised it.
  await replay([agentText(2, "Bonjour."), state("listening"), userVoice(3, "Hello ?")]);
  assert.deepEqual(events, ["started", "stopped"]);

  await session.close();
  assert.equal(vad.closed, true);
});

test("barge-in needs the agent's Ultravox minimumInterruptionDuration of speech", () => {
  assert.equal(ultravoxBargeInMinSpeechMs(buildRealtimeLlmOptions(ULTRAVOX, agent, "c")), 480);
  const custom = { ...agent, options: { ...agent.options, vendorSpecific: { ultravox: { vadSettings: { minimumInterruptionDuration: "0.8s" } } } } };
  assert.equal(ultravoxBargeInMinSpeechMs(buildRealtimeLlmOptions(ULTRAVOX, custom, "c")), 800);
  const unset = { ...agent, options: { ...agent.options, vendorSpecific: { ultravox: { vadSettings: { turnEndpointDelay: "0.5s" } } } } };
  assert.equal(ultravoxBargeInMinSpeechMs(buildRealtimeLlmOptions(ULTRAVOX, unset, "c")), 480);
});
