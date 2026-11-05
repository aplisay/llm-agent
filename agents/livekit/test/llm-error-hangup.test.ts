import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
  llm,
  tts,
  voice,
  type APIConnectOptions,
} from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import {
  LLM_ERROR_MESSAGE,
  createLlmErrorHangup,
  isPermanentLlmError,
  llmErrorMessageFor,
  type LlmErrorHangupParams,
} from "../lib/llm-error-hangup.js";

// A pipeline LLM that fails every turn (a revoked key: a 401 each time) left the caller in
// silence. Offline: a real AgentSession with a failing LLM and a fake TTS, and a fake session.
// run: npx tsx --test test/llm-error-hangup.test.ts

initializeLogger({ pretty: false, level: "fatal" });

const SAMPLE_RATE = 24000;

const unauthorised = () =>
  new APIStatusError({ message: "401 Incorrect API key provided", options: { statusCode: 401, retryable: false } });
const retriesSpent = () =>
  new APIConnectionError({ message: "failed to generate LLM completion after 4 attempts", options: { retryable: false } });

class FailingLLM extends llm.LLM {
  requests = 0;
  constructor(readonly makeError: () => Error) {
    super();
  }
  label() {
    return "failing.LLM";
  }
  chat({ chatCtx, toolCtx, connOptions }: { chatCtx: llm.ChatContext; toolCtx?: llm.ToolContext; connOptions?: APIConnectOptions }) {
    this.requests++;
    const stream = new FailingStream(this, { chatCtx, toolCtx, connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS });
    // LLMStream keeps its LLM private; run() starts later (startSoon), after this is set.
    stream.makeError = this.makeError;
    return stream;
  }
}

class FailingStream extends llm.LLMStream {
  makeError?: () => Error;
  protected async run() {
    throw this.makeError!();
  }
}

/** A streaming TTS that records each flushed segment and answers with silence. */
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
        this.markStarted();
        const samples = SAMPLE_RATE / 10;
        const frame = new AudioFrame(new Int16Array(samples), SAMPLE_RATE, 1, samples);
        this.queue.put({ requestId: "r", segmentId: "s", frame, final: true });
        text = "";
      }
    }
    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }
}

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

async function until(done: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50));

/** Every guard open, as on a plain call after start-up. */
function guards(session: unknown, overrides: Partial<LlmErrorHangupParams> = {}) {
  const ended: string[] = [];
  const params: LlmErrorHangupParams = {
    currentSession: () => session,
    startupSettled: () => true,
    isCleaningUp: () => false,
    handoverInProgress: () => false,
    isBridged: () => false,
    consultInProgress: () => false,
    message: () => LLM_ERROR_MESSAGE,
    endCall: async () => void ended.push("ended"),
    ...overrides,
  };
  return { params, ended };
}

/** A real pipeline AgentSession whose LLM fails every request. */
async function failingCall(makeError: () => Error, arm = true) {
  const failing = new FailingLLM(makeError);
  const fakeTts = new FakeTTS();
  const session = new voice.AgentSession({ llm: failing, tts: fakeTts });
  session.output.audio = new FakeAudioOutput() as any;
  const closes: voice.CloseEvent[] = [];
  session.on(voice.AgentSessionEventTypes.Close, (ev) => closes.push(ev));
  const { params, ended } = guards(session, {
    endCall: async () => {
      // The SDK must not have closed the session before the line was spoken.
      ended.push(closes.length ? "ended after SDK close" : "ended");
    },
  });
  if (arm) createLlmErrorHangup(params).arm(session, { callId: "call-1" });
  await session.start({ agent: new voice.Agent({ instructions: "You are reception." }) });
  /** One caller turn, answered by a failed LLM request. */
  const turn = async (userInput: string) => {
    const want = failing.requests + 1;
    session.generateReply({ userInput });
    await until(() => failing.requests >= want, `the LLM request for "${userInput}"`);
    await settle();
  };
  return { session, fakeTts, closes, ended, turn };
}

test("agents-js 1.9.0 closes the session only at the 4th unrecoverable llm_error in a row", async () => {
  // LLM_ERROR_LIMIT relies on this: if an upgrade lowers it, the session closes before we speak.
  const call = await failingCall(unauthorised, false);
  try {
    for (const n of [1, 2, 3]) await call.turn(`hello ${n}`);
    assert.equal(call.closes.length, 0);
    assert.deepEqual(call.fakeTts.segments, []);
    await call.turn("hello 4");
    await until(() => call.closes.length > 0, "the SDK to close the session");
    assert.equal(call.closes[0].reason, voice.CloseReason.ERROR);
  } finally {
    await call.session.close();
  }
});

test("a 401 on the first turn: the caller hears the line, then the call ends", async () => {
  const call = await failingCall(unauthorised);
  try {
    await call.turn("hello");
    await until(() => call.ended.length > 0, "the call to end");
    assert.deepEqual(call.fakeTts.segments, [LLM_ERROR_MESSAGE]);
    assert.deepEqual(call.ended, ["ended"]);
  } finally {
    await call.session.close();
  }
});

test("an error that is not a 4xx acts on the 2nd in a row, before the SDK gives up", async () => {
  const call = await failingCall(retriesSpent);
  try {
    await call.turn("hello");
    assert.deepEqual(call.ended, []);
    assert.deepEqual(call.fakeTts.segments, []);
    await call.turn("are you there?");
    await until(() => call.ended.length > 0, "the call to end");
    assert.deepEqual(call.fakeTts.segments, [LLM_ERROR_MESSAGE]);
    assert.deepEqual(call.ended, ["ended"]);
  } finally {
    await call.session.close();
  }
});

/** The two session events the hangup listens to, and what it says. */
class FakeSession extends EventEmitter {
  said: { text: string; options: unknown }[] = [];
  playout: () => Promise<void> = async () => {};
  say(text: string, options?: unknown) {
    this.said.push({ text, options });
    return { waitForPlayout: () => this.playout() } as any;
  }
  llmError(error: Error, recoverable = false) {
    this.emit(voice.AgentSessionEventTypes.Error, { type: "error", error: { type: "llm_error", error, recoverable } });
  }
  agentState(newState: string) {
    this.emit(voice.AgentSessionEventTypes.AgentStateChanged, { newState });
  }
}

function armed(overrides: Partial<LlmErrorHangupParams> = {}, session = new FakeSession()) {
  const { params, ended } = guards(session, overrides);
  createLlmErrorHangup(params).arm(session as any, { callId: "call-1" });
  return { session, ended };
}

test("the line is not interruptible and stays out of the chat context", async () => {
  const { session, ended } = armed();
  session.llmError(unauthorised());
  await until(() => ended.length > 0, "the call to end");
  assert.deepEqual(session.said, [{ text: LLM_ERROR_MESSAGE, options: { allowInterruptions: false, addToChatCtx: false } }]);
});

test("the agent speaking between errors resets the count", async () => {
  const { session, ended } = armed();
  session.llmError(retriesSpent());
  session.agentState("speaking");
  session.llmError(retriesSpent());
  await settle();
  assert.deepEqual(ended, []);
  session.llmError(retriesSpent());
  await until(() => ended.length > 0, "the call to end");
});

test("recoverable LLM errors and other models' errors are not counted", async () => {
  const { session, ended } = armed();
  session.llmError(unauthorised(), true);
  session.emit(voice.AgentSessionEventTypes.Error, { error: { type: "tts_error", error: unauthorised(), recoverable: false } });
  session.emit(voice.AgentSessionEventTypes.Error, { error: { type: "realtime_model_error", error: unauthorised(), recoverable: false } });
  await settle();
  assert.deepEqual(ended, []);
  assert.deepEqual(session.said, []);
});

test("nothing happens while another path owns the call", async () => {
  const cases: [string, Partial<LlmErrorHangupParams>][] = [
    ["start-up window open (fallback chain)", { startupSettled: () => false }],
    ["call already coming down", { isCleaningUp: () => true }],
    ["full-stack handover", { handoverInProgress: () => true }],
    ["bridged to a transfer target", { isBridged: () => true }],
    ["caller on hold for a consult", { consultInProgress: () => true }],
    ["session replaced by a handover", { currentSession: () => null }],
  ];
  for (const [what, overrides] of cases) {
    const { session, ended } = armed(overrides);
    session.llmError(unauthorised());
    session.llmError(unauthorised());
    await settle();
    assert.deepEqual(ended, [], what);
    assert.deepEqual(session.said, [], what);
  }
});

test("it fires once, however many errors follow", async () => {
  const { session, ended } = armed();
  session.llmError(unauthorised());
  session.llmError(unauthorised());
  session.llmError(retriesSpent());
  await until(() => ended.length > 0, "the call to end");
  await settle();
  assert.equal(session.said.length, 1);
  assert.deepEqual(ended, ["ended"]);
});

test("the call still ends if the line cannot be spoken or never finishes", async () => {
  const broken = new FakeSession();
  broken.say = () => {
    throw new Error("AgentSession is not running");
  };
  const a = armed({}, broken);
  a.session.llmError(unauthorised());
  await until(() => a.ended.length > 0, "the call to end after say() threw");

  const stuck = new FakeSession();
  stuck.playout = () => new Promise(() => {});
  const b = armed({ speechCapMs: 30 }, stuck);
  b.session.llmError(unauthorised());
  await until(() => b.ended.length > 0, "the call to end after the speech cap");
});

test("the message is read when the hangup fires", async () => {
  let message = "first agent";
  const { session, ended } = armed({ message: () => message });
  message = "second agent";
  session.llmError(unauthorised());
  await until(() => ended.length > 0, "the call to end");
  assert.equal(session.said[0].text, "second agent");
});

test("isPermanentLlmError: a non-retryable 4xx only", () => {
  assert.equal(isPermanentLlmError(unauthorised()), true);
  assert.equal(isPermanentLlmError(new APIStatusError({ options: { statusCode: 404 } })), true);
  assert.equal(isPermanentLlmError(new APIStatusError({ options: { statusCode: 429 } })), false);
  assert.equal(isPermanentLlmError(new APIStatusError({ options: { statusCode: 500, retryable: false } })), false);
  assert.equal(isPermanentLlmError(retriesSpent()), false);
  assert.equal(isPermanentLlmError(undefined), false);
});

test("llmErrorMessageFor: the agent's fallback.message text, else the fixed line", () => {
  const agent = (options: Record<string, unknown>) => ({ modelName: "livekit:openai/gpt-4o", options }) as any;
  assert.equal(
    llmErrorMessageFor(agent({ fallback: { message: { text: "Désolé, nous ne pouvons pas continuer." } } })),
    "Désolé, nous ne pouvons pas continuer.",
  );
  assert.equal(llmErrorMessageFor(agent({})), LLM_ERROR_MESSAGE);
  assert.equal(llmErrorMessageFor(agent({ fallback: { message: "bare string" } })), LLM_ERROR_MESSAGE);
  assert.equal(llmErrorMessageFor(agent({ fallback: { message: { text: "  " } } })), LLM_ERROR_MESSAGE);
});
