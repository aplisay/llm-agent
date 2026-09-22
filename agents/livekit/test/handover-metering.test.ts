import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
  llm,
  stt,
  tts,
  voice,
  type APIConnectOptions,
} from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { createTools } from "../lib/agent-tools.js";
import { HANDOVER_OPENING_INSTRUCTION, HandoverAgent, openingReply } from "../lib/handover-opening.js";
import { makeMetricsMeter, makeUsageMeter } from "../lib/usage-meter.js";

// Usage metering across in-place transfer_agent handovers, offline: a real AgentSession with a
// scripted LLM, a fake streaming TTS and a fake STT. The handover goes through the worker's own
// transfer_agent tool (createTools) to a HandoverAgent built as onAgentTransfer builds it.
// run: npx tsx --test test/handover-metering.test.ts

initializeLogger({ pretty: false, level: "fatal" });

const SAMPLE_RATE = 24000;
const REPLY = "Of course, I can help you with that.";
const TRANSFER_REQUEST = "Can you put me through to someone else?";
/** What the scripted LLM reports for every request. */
const USAGE = { promptTokens: 120, promptCachedTokens: 20, completionTokens: 9, totalTokens: 129 };
/** The fake TTS answers with 10 ms of audio per character. */
const audioMs = (text: string) => text.length * 10;

const silence = (ms: number) => {
  const samples = (ms * SAMPLE_RATE) / 1000;
  return new AudioFrame(new Int16Array(samples), SAMPLE_RATE, 1, samples);
};

/** Calls transfer_agent when the caller asks to be put through, and answers REPLY otherwise. */
class ScriptedLLM extends llm.LLM {
  requests = 0;
  label() {
    return "fake.LLM";
  }
  chat({ chatCtx, toolCtx, connOptions }: { chatCtx: llm.ChatContext; toolCtx?: llm.ToolContext; connOptions?: APIConnectOptions }) {
    this.requests++;
    return new ScriptedStream(this, { chatCtx, toolCtx, connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS });
  }
}

let toolCalls = 0;

class ScriptedStream extends llm.LLMStream {
  protected async run() {
    const last = this.chatCtx.items.at(-1);
    const transfer = last?.type === "message" && last.role === "user" && last.textContent === TRANSFER_REQUEST;
    this.queue.put({
      id: "reply",
      delta: transfer
        ? {
            role: "assistant",
            toolCalls: [llm.FunctionCall.create({ callId: `call-${++toolCalls}`, name: "transfer_agent", args: "{}" })],
          }
        : { role: "assistant", content: REPLY },
    });
    this.queue.put({ id: "reply", usage: USAGE });
  }
}

/** A streaming TTS: one final frame per flushed segment, so the SDK meters each reply once. */
class FakeTTS extends tts.TTS {
  label = "fake.TTS";
  segments: string[] = [];
  constructor() {
    super(SAMPLE_RATE, 1, { streaming: true });
  }
  synthesize(): tts.ChunkedStream {
    throw new Error("not used");
  }
  stream({ connOptions }: { connOptions?: APIConnectOptions } = {}) {
    return new FakeSynthesizeStream(this, connOptions);
  }
}

class FakeSynthesizeStream extends tts.SynthesizeStream {
  label = "fake.SynthesizeStream";
  readonly #tts: FakeTTS;
  constructor(ttsInstance: FakeTTS, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#tts = ttsInstance;
  }
  protected async run() {
    let text = "";
    for await (const input of this.input) {
      if (input !== tts.SynthesizeStream.FLUSH_SENTINEL) {
        text += input;
      } else if (text) {
        this.#tts.segments.push(text);
        this.queue.put({ requestId: "r", segmentId: "s", frame: silence(audioMs(text)), final: true });
        text = "";
      }
    }
    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }
}

/** A session-level STT. No audio reaches the session, so its metrics come from recognize(). */
class FakeSTT extends stt.STT {
  label = "fake.STT";
  constructor() {
    super({ streaming: true, interimResults: false });
  }
  async _recognize(): Promise<stt.SpeechEvent> {
    return { type: stt.SpeechEventType.FINAL_TRANSCRIPT };
  }
  stream({ connOptions }: { connOptions?: APIConnectOptions } = {}) {
    return new IdleSpeechStream(this, SAMPLE_RATE, connOptions);
  }
}

class IdleSpeechStream extends stt.SpeechStream {
  label = "fake.SpeechStream";
  protected async run() {
    for await (const _ of this.input) {
      // no audio reaches this session
    }
  }
}

/** A realtime model with text output. Each activity opens its own session from it. */
class FakeRealtimeModel extends llm.RealtimeModel {
  sessions: FakeRealtimeSession[] = [];
  constructor() {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: false,
      audioOutput: false,
    });
  }
  get model() {
    return "fake-realtime";
  }
  session() {
    const s = new FakeRealtimeSession(this);
    this.sessions.push(s);
    return s;
  }
  async close() {}
}

class FakeRealtimeSession extends llm.RealtimeSession {
  closed = false;
  #chatCtx = llm.ChatContext.empty();
  get chatCtx() {
    return this.#chatCtx;
  }
  get tools() {
    return {};
  }
  async updateInstructions() {}
  async updateChatCtx(chatCtx: llm.ChatContext) {
    this.#chatCtx = chatCtx;
  }
  async updateTools() {}
  updateOptions() {}
  pushAudio() {}
  async generateReply(): Promise<llm.GenerationCreatedEvent> {
    throw new Error("not used");
  }
  async commitAudio() {}
  async clearAudio() {}
  async interrupt() {}
  async truncate() {}
  async close() {
    this.closed = true;
    await super.close();
  }
  /** The usage of one response, as a realtime plugin reports it. */
  respond() {
    this.emit("metrics_collected", {
      type: "realtime_model_metrics",
      label: "fake.realtime",
      requestId: "response",
      timestamp: Date.now(),
      inputTokens: 300,
      outputTokens: 40,
      inputTokenDetails: { audioTokens: 0, textTokens: 300, imageTokens: 0, cachedTokens: 60 },
    });
  }
}

/** An agent that notes when the SDK has started its activity. */
class EnteredAgent extends voice.Agent {
  entered = false;
  async onEnter() {
    this.entered = true;
  }
}

/** Takes a reply's audio as the room output would, and reports playout done at once. */
class FakeAudioOutput extends EventEmitter {
  readonly canPause = false;
  #capturing = false;
  async captureFrame() {
    if (!this.#capturing) {
      this.#capturing = true;
      this.emit("playbackStarted", { createdAt: Date.now() });
    }
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

/** Poll until `done()`; replies and their metrics land a few promise turns apart. */
async function until(done: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Give late metrics a chance to arrive before counting. */
const settle = () => new Promise((r) => setTimeout(r, 50));

/** How many times the session reported each metrics object, in order of first report. */
const copies = (reported: unknown[]) => [...new Set(reported)].map((m) => reported.filter((r) => r === m).length);

/** A transfer_agent builtin with a fixed target, as it appears in an agent's functions. */
const transferTo = (target: string) => ({
  name: "transfer_agent",
  description: "Hand the caller to another agent",
  implementation: "builtin",
  platform: "transfer_agent",
  input_schema: {
    type: "object",
    properties: { agent: { type: "string", source: "static", from: target } },
  },
});

/** reception hands over to billing, and billing to accounts. */
const AGENTS: Record<string, any> = {
  reception: { id: "reception", organisationId: "org-1", functions: [transferTo("billing")], keys: [] },
  billing: { id: "billing", organisationId: "org-1", functions: [transferTo("accounts")], keys: [] },
  accounts: { id: "accounts", organisationId: "org-1", functions: [], keys: [] },
};

/** The agent's tools, with an onAgentTransfer that returns what the runtime's in-place branch does. */
function toolsFor(agentId: string): llm.ToolContext {
  return createTools({
    agent: AGENTS[agentId],
    call: { id: "call-1" } as any,
    room: {} as any,
    participant: null,
    sendMessage: async () => {},
    metadata: {} as any,
    onHangup: async () => ({ status: "OK" }) as any,
    onTransfer: async () => {
      throw new Error("not used");
    },
    getTransferState: () => ({ state: "none", description: "" }),
    onAgentTransfer: async ({ agent: target }) => ({
      handoffAgent: new HandoverAgent(
        { instructions: `You are ${target}.`, tools: toolsFor(target) },
        openingReply("pipeline", HANDOVER_OPENING_INSTRUCTION),
      ),
      detail: "in-place handover",
    }),
  });
}

/** A pipeline call answered by reception, metered as the worker meters a call. */
async function receptionCall() {
  const fakeLlm = new ScriptedLLM();
  const fakeTts = new FakeTTS();
  const fakeStt = new FakeSTT();
  const session = new voice.AgentSession({ llm: fakeLlm, tts: fakeTts, stt: fakeStt });
  session.output.audio = new FakeAudioOutput() as any;
  // Every metrics object the session reports, once per MetricsCollected event.
  const reported: unknown[] = [];
  session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev: any) => reported.push(ev.metrics));
  const saved: any[] = [];
  const meter = makeUsageMeter({
    getCall: () => ({ id: "call-1", organisationId: "org-1", userId: "u1", agentId: "reception" }),
    usageVendors: { llm: {}, tts: {}, stt: {} } as any,
    voiceMode: "pipeline",
    saveUsageFn: async (records) => void saved.push(...(records as any[])),
  });
  meter.wire(session);
  await session.start({ agent: new voice.Agent({ instructions: "You are reception.", tools: toolsFor("reception") }) });

  /** One caller turn and the replies it sets off, spoken and metered. */
  const turn = async (userInput: string, { requests = 1, segments = 1 } = {}) => {
    const wantRequests = fakeLlm.requests + requests;
    const wantSegments = fakeTts.segments.length + segments;
    session.generateReply({ userInput });
    await until(
      () => fakeLlm.requests >= wantRequests && fakeTts.segments.length >= wantSegments,
      `the replies to "${userInput}"`,
    );
    await until(() => session.agentState === "listening", "the agent to finish speaking");
    await settle();
  };
  /**
   * Ask to be put through. Three LLM requests: the transfer_agent call, the outgoing agent's reply
   * to its result, and the incoming agent's opening. The last two are spoken.
   */
  const handover = async (to: string) => {
    await turn(TRANSFER_REQUEST, { requests: 3, segments: 2 });
    assert.equal(session.currentAgent.instructions, `You are ${to}.`);
  };
  let recognitions = 0;
  /** A second of the caller's audio through the session STT, which reports its metrics itself. */
  const recognise = async () => {
    recognitions++;
    await fakeStt.recognize(silence(1000) as any);
  };
  /** The usage rows the call would write, by technology and unit. */
  const ledger = async () => {
    saved.length = 0;
    await meter.flush(true);
    return Object.fromEntries(saved.map((r) => [`${r.technology} ${r.unit}`, r.quantity]));
  };
  /** What the fakes produced, in the same form. */
  const produced = () => ({
    "llm input_tokens": fakeLlm.requests * (USAGE.promptTokens - USAGE.promptCachedTokens),
    "llm output_tokens": fakeLlm.requests * USAGE.completionTokens,
    "llm cache_read_tokens": fakeLlm.requests * USAGE.promptCachedTokens,
    "tts characters": fakeTts.segments.join("").length,
    "tts milliseconds": audioMs(fakeTts.segments.join("")),
    "stt milliseconds": recognitions * 1000,
  });
  return { session, fakeLlm, fakeTts, fakeStt, reported, turn, handover, recognise, ledger, produced };
}

test("agents-js 1.0.46: after an in-place handover every metrics event reaches the session twice", async () => {
  const call = await receptionCall();
  try {
    await call.turn("Hello");
    await call.recognise();
    assert.deepEqual(copies(call.reported), [1, 1, 1], "llm, tts and stt, once each");
    for (const component of [call.fakeLlm, call.fakeTts, call.fakeStt]) {
      assert.equal(component.listenerCount("metrics_collected"), 1);
    }

    await call.handover("billing");
    const before = call.reported.length;
    await call.turn("What do I owe?");
    await call.recognise();

    // The outgoing activity's listeners are still on the session's LLM, TTS and STT.
    for (const component of [call.fakeLlm, call.fakeTts, call.fakeStt]) {
      assert.equal(component.listenerCount("metrics_collected"), 2);
    }
    assert.deepEqual(copies(call.reported.slice(before)), [2, 2, 2]);
  } finally {
    await call.session.close();
  }
});

test("after an in-place handover the usage rows match what the LLM, TTS and STT produced", async () => {
  const call = await receptionCall();
  try {
    await call.turn("Hello");
    await call.recognise();
    await call.handover("billing");
    await call.turn("What do I owe?");
    await call.recognise();

    const rows = await call.ledger();
    assert.deepEqual(rows, call.produced());
    assert.equal(call.fakeLlm.requests, 5);
    assert.equal(rows["tts characters"], 4 * REPLY.length);
  } finally {
    await call.session.close();
  }
});

test("agents-js 1.0.46: after a second in-place handover each event arrives three times, and is metered once", async () => {
  const call = await receptionCall();
  try {
    await call.turn("Hello");
    await call.handover("billing");
    await call.handover("accounts");
    const before = call.reported.length;
    await call.turn("What do I owe?");
    await call.recognise();

    assert.deepEqual(copies(call.reported.slice(before)), [3, 3, 3]);
    assert.deepEqual(await call.ledger(), call.produced());
  } finally {
    await call.session.close();
  }
});

test("agents-js 1.0.46, realtime: each activity has its own realtime session, so only the session TTS repeats", async () => {
  const model = new FakeRealtimeModel();
  const fakeTts = new FakeTTS();
  const session = new voice.AgentSession({ llm: model, tts: fakeTts });
  session.output.audio = new FakeAudioOutput() as any;
  const reported: any[] = [];
  session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev: any) => reported.push(ev.metrics));
  // Metered as the runtime meters a realtime session with text output, which keeps its TTS rows.
  const metered: Record<string, number> = {};
  const meterOnce = makeMetricsMeter((technology, _label, unit, quantity) => {
    metered[`${technology} ${unit}`] = (metered[`${technology} ${unit}`] ?? 0) + (quantity ?? 0);
  });
  session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev: any) => meterOnce(ev.metrics));
  await session.start({ agent: new voice.Agent({ instructions: "You are reception." }) });
  const reply = async () => {
    model.sessions.at(-1)!.respond();
    await session.say(REPLY).waitForPlayout();
    await settle();
  };
  try {
    await reply();
    assert.deepEqual(copies(reported), [1, 1]);

    // What the SDK does with a tool's llm.handoff() on a realtime model too.
    const billing = new EnteredAgent({ instructions: "You are billing." });
    session.updateAgent(billing);
    await until(() => billing.entered, "the incoming agent's activity to start");
    const before = reported.length;
    await reply();

    // The outgoing activity closed its realtime session, and the new one has one listener.
    assert.equal(model.sessions.length, 2);
    assert.equal(model.sessions[0].closed, true);
    assert.equal(model.sessions[1].listenerCount("metrics_collected"), 1);
    const after = reported.slice(before);
    assert.deepEqual(
      [...new Set(after)].map((m) => [m.type, after.filter((r) => r === m).length]),
      [
        ["realtime_model_metrics", 1],
        ["tts_metrics", 2],
      ],
    );
    assert.deepEqual(metered, {
      "llm input_tokens": 2 * (300 - 60),
      "llm output_tokens": 2 * 40,
      "llm cache_read_tokens": 2 * 60,
      "tts characters": 2 * REPLY.length,
      "tts milliseconds": 2 * audioMs(REPLY),
    });
  } finally {
    await session.close();
  }
});
