import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { initializeLogger, llm, voice } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import {
  buildRealtimeLlmOptions,
  createVoiceModelAndSession,
  legacyTurnHandlingOptions,
} from "../lib/voice-session-factory.js";
import { RealtimeModel } from "../plugins/ultravox/src/realtime/realtime_model.js";
import { UltravoxClient } from "../plugins/ultravox/src/realtime/ultravox_client.js";

// agents-js 1.9 stops reading a reply's audio after 10 s with no frame. An Ultravox reply
// stays open across its tool calls, so the answer to a slow lookup was never played (prod
// call be8d4d2c, 2026-10-05: three knowledge-base lookups, then "So how is it?").
// run: npx tsx --test test/realtime-audio-idle-timeout.test.ts

initializeLogger({ pretty: false, level: process.env.TEST_LOG || "fatal" });

for (const key of ["OPENAI_API_KEY", "ULTRAVOX_API_KEY", "GOOGLE_API_KEY", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) {
  process.env[key] ??= "test-key";
}

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const NODE_MAX_TIMER_MS = 2 ** 31 - 1;
const SDK_DEFAULT_MS = 10_000;

const makeAgent = (options: Record<string, unknown> = {}) =>
  ({ prompt: "You are a test agent.", options, functions: [] }) as any;

const build = (voiceMode: "pipeline" | "realtime", modelName: string, agent = makeAgent()) =>
  createVoiceModelAndSession({ voiceMode, modelName, agent, call: { id: "call-1" } as any, tools: undefined as any })
    .session as any;

test("realtime sessions wait for audio as long as a Node timer can; pipeline keeps the SDK guard", () => {
  for (const [modelName, agent] of [
    ["livekit:openai/gpt-realtime", makeAgent()],
    [ULTRAVOX, makeAgent()],
    [ULTRAVOX, makeAgent({ tts: { vendor: "cartesia" } })],
    ["livekit:google/gemini-2.0-flash-exp", makeAgent()],
  ] as const) {
    const o = build("realtime", modelName, agent).sessionOptions;
    assert.equal(o.forwardAudioIdleTimeout, NODE_MAX_TIMER_MS, modelName);
    assert.equal(o.ttsReadIdleTimeout, NODE_MAX_TIMER_MS, modelName);
  }
  const o = build("pipeline", "livekit:openai/gpt-4o-mini").sessionOptions;
  assert.equal(o.forwardAudioIdleTimeout, SDK_DEFAULT_MS);
  assert.equal(o.ttsReadIdleTimeout, SDK_DEFAULT_MS);
});

/** Takes a reply's audio as the room output would, and reports playout done at once. */
class FakeAudioOutput extends EventEmitter {
  readonly canPause = false;
  frames: AudioFrame[] = [];
  #capturing = false;

  async captureFrame(frame: AudioFrame) {
    if (!this.#capturing) {
      this.#capturing = true;
      this.emit("playbackStarted", { createdAt: Date.now() });
    }
    this.frames.push(frame);
  }
  flush() {
    this.#capturing = false;
  }
  clearBuffer() {
    this.#capturing = false;
  }
  async waitForPlayout() {
    return { playbackPosition: 0, interrupted: false };
  }
  onAttached() {}
  onDetached() {}
  pause() {}
  resume() {}
}

/** 100 ms of Ultravox output audio (two 50 ms frames), every sample set to `marker`. */
const ultravoxAudio = (marker: number) => Buffer.from(new Int16Array(2400).fill(marker).buffer);

/** setTimeout is mocked during a reply, so wait on the event loop against the real clock. */
async function until(done: () => boolean, what: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Run one Ultravox reply on `session` through a stand-in Ultravox socket: "One moment",
 * a lookup that takes 15 s, then the answer. Returns the markers of the frames played.
 */
async function replyAcrossSlowTool(t: TestContext, makeSession: (tools: llm.ToolContext) => voice.AgentSession) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;
  t.mock.method(UltravoxClient.prototype, "createCall", async () => ({ callId: "uv-test", joinUrl: `ws://127.0.0.1:${port}/` }));
  t.mock.method(UltravoxClient.prototype, "deleteCall", async () => {});
  t.after(() => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });

  let lookupCalled = false;
  let finishLookup!: () => void;
  const lookupDone = new Promise<void>((resolve) => (finishLookup = resolve));
  const tools = new llm.ToolContext({
    lookup: llm.tool({
      description: "Look something up.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        lookupCalled = true;
        await lookupDone;
        return { answer: "found" };
      },
    }),
  });

  // The plugin reads the socket only once it has reported session_created.
  let ready!: Promise<unknown>;
  const newSession = RealtimeModel.prototype.session;
  t.mock.method(RealtimeModel.prototype, "session", function (this: RealtimeModel) {
    const rtSession = newSession.call(this);
    ready = once(rtSession as any, "session_created");
    return rtSession;
  });

  const session = makeSession(tools);
  const output = new FakeAudioOutput();
  session.output.audio = output as any;
  const connected = once(wss, "connection") as Promise<[WebSocket]>;
  await session.start({ agent: new voice.Agent({ instructions: "You are a test agent.", tools }), record: false });
  const [socket] = await connected;
  await ready;
  const toolResults: unknown[] = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(String(data));
    if (message.type === "client_tool_result") toolResults.push(message);
  });
  const send = (frame: object | Buffer) => socket.send(Buffer.isBuffer(frame) ? frame : JSON.stringify(frame));
  const speeches: voice.SpeechHandle[] = [];
  session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => speeches.push(ev.speechHandle));

  // The mocked clearTimeout cannot clear this real timer, which would hold the process open.
  (session as any)._cancelUserAwayTimer();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    send({ type: "state", state: "speaking" });
    send(ultravoxAudio(1));
    await until(() => output.frames.length === 2, "the opening audio");

    send({ type: "state", state: "thinking" });
    send({ type: "client_tool_invocation", toolName: "lookup", invocationId: "inv-1", parameters: {} });
    await until(() => lookupCalled, "the lookup to start");
    t.mock.timers.tick(15_000);
    finishLookup();
    await until(() => toolResults.length === 1, "the lookup result");

    send({ type: "state", state: "speaking" });
    send(ultravoxAudio(2));
    send({ type: "state", state: "listening" });
    await until(() => speeches.length === 1 && speeches[0]!.done(), "the reply to finish");
    return [...new Set(output.frames.map((f) => f.data[0]))];
  } finally {
    t.mock.timers.reset();
    await session.close();
  }
}

test("the SDK default drops the answer that follows a 15 s tool call (the regression)", async (t) => {
  const played = await replyAcrossSlowTool(
    t,
    () =>
      new voice.AgentSession({
        llm: new RealtimeModel({ ...buildRealtimeLlmOptions(ULTRAVOX, makeAgent(), "call-1"), apiKey: "test-key" } as any),
        ...legacyTurnHandlingOptions({ turnDetection: null }),
      } as any),
  );
  assert.deepEqual(played, [1]);
});

test("a realtime session from the factory plays the answer that follows a 15 s tool call", async (t) => {
  const played = await replyAcrossSlowTool(
    t,
    (tools) =>
      createVoiceModelAndSession({ voiceMode: "realtime", modelName: ULTRAVOX, agent: makeAgent(), call: { id: "call-1" } as any, tools })
        .session,
  );
  assert.deepEqual(played, [1, 2]);
});
