import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import {
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
  llm,
  tts,
  voice,
  type APIConnectOptions,
} from "@livekit/agents";
import * as google from "@livekit/agents-plugin-google";
import type { AudioFrame } from "@livekit/rtc-node";
import { makeUsageMeter } from "../lib/usage-meter.js";
import { resolveUsageVendors, type UsageVendors } from "../lib/usage-vendors.js";
import { resolvePipelineTts } from "../lib/pipeline-inference-options.js";
import { SentenceStreamTTS } from "../lib/sentence-stream-tts.js";
import { buildPipelineTts, createVoiceModelAndSession } from "../lib/voice-session-factory.js";

// Gemini TTS usage on a pipeline session, offline: the real plugin with its API call stubbed.
// run: npx tsx --test test/gemini-tts-metering.test.ts

initializeLogger({ pretty: false, level: "fatal" });

const SAMPLE_RATE = 24000;
/** Three sentences for the SDK's sentence tokenizer: 41, 50 and 32 characters. */
const REPLY =
  "Thanks for calling the Riverside surgery. I can book, move or cancel an appointment for you. What would you like to do today?";
const SENTENCES = [
  "Thanks for calling the Riverside surgery.",
  "I can book, move or cancel an appointment for you.",
  "What would you like to do today?",
];
/** The stub answers with 10 ms of audio per character. */
const audioMs = (text: string) => text.length * 10;
const REPLY_AUDIO_MS = SENTENCES.reduce((ms, s) => ms + audioMs(s), 0);

/** The plugin sends `<instructions>:\n"<text>"`. */
const REQUEST_TEXT = /:\n"([\s\S]*)"$/;

type Stub = { delayMs?: (n: number) => number; fail?: (n: number) => Error | undefined };

/**
 * Answer a Gemini TTS's API calls locally: 10 ms of audio per character of the requested
 * text, every sample set to the request's number so playout order can be read back.
 */
function stubGemini(gemini: google.beta.TTS, { delayMs = () => 0, fail = () => undefined }: Stub = {}) {
  const requests: string[] = [];
  (gemini.client.models as any).generateContentStream = async (params: any) => {
    const text = REQUEST_TEXT.exec(params.contents[0].parts[0].text)![1]!;
    const n = requests.push(text);
    const pcm = new Int16Array((audioMs(text) * SAMPLE_RATE) / 1000).fill(n);
    const signal: AbortSignal | undefined = params.config?.abortSignal;
    return (async function* () {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs(n));
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      const error = fail(n);
      if (error) throw error;
      const data = Buffer.from(pcm.buffer).toString("base64");
      yield { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data } }] } }] };
    })();
  };
  return requests;
}

const rawGemini = () => new google.beta.TTS({ apiKey: "test-key", vertexai: false });

const agent = (ttsOptions: Record<string, unknown>) =>
  ({ prompt: "Test agent.", options: { tts: ttsOptions } }) as any;

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const apply = (vars: Record<string, string | undefined>) =>
    Object.entries(vars).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  apply(env);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

/** The Gemini TTS a google pipeline agent gets on this worker, with its API stubbed. */
function builtGemini(stub: Stub = {}, ttsOptions: Record<string, unknown> = { vendor: "google", voice: "Kore" }) {
  const built = withEnv(
    {
      GOOGLE_API_KEY: "test-key",
      GOOGLE_GENAI_USE_VERTEXAI: undefined,
      LIVEKIT_PIPELINE_GOOGLE_TTS: undefined,
      LIVEKIT_PIPELINE_GEMINI_TTS_VOICE: undefined,
    },
    () => buildPipelineTts(agent(ttsOptions)),
  ) as SentenceStreamTTS;
  const requests = stubGemini(built.inner as google.beta.TTS, stub);
  return { built, requests };
}

/** Takes a reply's audio as the room output would, and reports playout done at once. */
class FakeAudioOutput extends EventEmitter {
  readonly canPause = false;
  frames: AudioFrame[] = [];
  onFirstFrame = () => {};
  #capturing = false;

  async captureFrame(frame: AudioFrame) {
    if (!this.frames.length) this.onFirstFrame();
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

const framesMs = (frames: AudioFrame[]) =>
  Math.round(frames.reduce((ms, f) => ms + (f.samplesPerChannel / f.sampleRate) * 1000, 0));

/**
 * The request number each frame came from, run-length encoded: [1, 2, 3] is in order. The
 * plugin sends an empty frame after audio that fills its last frame exactly.
 */
const playoutOrder = (frames: AudioFrame[]) =>
  frames
    .filter((f) => f.samplesPerChannel > 0)
    .map((f) => f.data[0])
    .filter((n, i, all) => i === 0 || n !== all[i - 1]);

/** Poll until `done()`; metrics land a few promise turns after playout. */
async function until(done: () => boolean, what: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Give late metrics a chance to arrive before asserting there are none. */
const settle = () => new Promise((r) => setTimeout(r, 50));

/**
 * Run `drive` on a real AgentSession whose TTS is `ttsInstance`, so replies go through the
 * SDK's default ttsNode, and meter the session as the runtime does.
 */
async function onSession(
  ttsInstance: tts.TTS,
  drive: (session: voice.AgentSession, ttsMetrics: any[]) => Promise<void>,
  {
    sink = new FakeAudioOutput(),
    llm: model,
    // resolvePipelineTts throws for google, so a Gemini row resolves no vendor and takes the SDK label.
    usageVendors = { llm: {}, tts: {}, stt: {} },
  }: { sink?: FakeAudioOutput; llm?: llm.LLM; usageVendors?: UsageVendors } = {},
) {
  const session = new voice.AgentSession({ tts: ttsInstance, ...(model ? { llm: model } : {}) } as any);
  session.output.audio = sink as any;
  const ttsMetrics: any[] = [];
  session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev: any) => {
    if (ev.metrics?.type === "tts_metrics") ttsMetrics.push(ev.metrics);
  });
  const saved: any[] = [];
  const meter = makeUsageMeter({
    getCall: () => ({ id: "call-1", organisationId: "o1", userId: "u1", agentId: "a1" }),
    usageVendors,
    voiceMode: "pipeline",
    saveUsageFn: async (records) => void saved.push(...(records as any[])),
  });
  meter.wire(session);
  await session.start({ agent: new voice.Agent({ instructions: "Test agent." }) });
  try {
    await drive(session, ttsMetrics);
  } finally {
    await session.close();
  }
  const ledger = async () => {
    saved.length = 0;
    await meter.flush(true);
    return Object.fromEntries(
      saved.filter((r) => r.technology === "tts").map((r) => [r.unit, { quantity: r.quantity, provider: r.provider, detail: r.detail }]),
    );
  };
  return { sink, ttsMetrics, ledger };
}

const speakOnSession = (
  ttsInstance: tts.TTS,
  text: string,
  {
    replies = 1,
    sink = new FakeAudioOutput(),
    usageVendors,
  }: { replies?: number; sink?: FakeAudioOutput; usageVendors?: UsageVendors } = {},
) =>
  onSession(
    ttsInstance,
    async (session) => {
      for (let i = 0; i < replies; i++) await session.say(text).waitForPlayout();
    },
    { sink, usageVendors },
  );

/** Streams REPLY a word at a time, as a voice LLM's reply arrives. */
class WordByWordLLM extends llm.LLM {
  label() {
    return "fake.LLM";
  }
  chat({ chatCtx, toolCtx, connOptions }: { chatCtx: llm.ChatContext; toolCtx?: llm.ToolContext; connOptions?: APIConnectOptions }) {
    return new WordByWordStream(this, { chatCtx, toolCtx, connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS });
  }
}

class WordByWordStream extends llm.LLMStream {
  protected async run() {
    for (const [i, word] of REPLY.split(" ").entries()) {
      await new Promise((r) => setTimeout(r, 20));
      if (this.abortController.signal.aborted) return;
      this.queue.put({ id: "reply", delta: { role: "assistant", content: (i ? " " : "") + word } });
    }
  }
}

/**
 * A TTS stream that gives up leaves a rejected promise behind in agents-js 1.0.46, which the
 * job process logs. Stand in for that handler while `fn` runs; return what it caught.
 */
async function withJobRejectionHandler(fn: () => Promise<void>): Promise<unknown[]> {
  const runner = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const caught: unknown[] = [];
  const handler = (reason: unknown) => caught.push(reason);
  process.on("unhandledRejection", handler);
  try {
    await fn();
    await settle();
  } finally {
    process.off("unhandledRejection", handler);
    runner.forEach((l) => process.on("unhandledRejection", l));
  }
  return caught;
}

async function collect(stream: AsyncIterable<unknown>) {
  const frames: AudioFrame[] = [];
  for await (const ev of stream) {
    if (ev === tts.SynthesizeStream.END_OF_STREAM) break;
    frames.push((ev as { frame: AudioFrame }).frame);
  }
  return frames;
}

const textStream = (chunks: string[]) =>
  new ReadableStream<string>({
    start(c) {
      chunks.forEach((t) => c.enqueue(t));
      c.close();
    },
  });

test("agents-js 1.0.46: the raw Gemini TTS on a session meters every reply twice", async () => {
  const gemini = rawGemini();
  const requests = stubGemini(gemini);

  const { sink, ttsMetrics, ledger } = await speakOnSession(gemini, REPLY);
  // One per sentence from its ChunkedStream, one for the reply from tts.StreamAdapter's stream.
  await until(() => ttsMetrics.length >= SENTENCES.length + 1, "the metrics");

  assert.deepEqual(requests, SENTENCES);
  assert.equal(framesMs(sink.frames), REPLY_AUDIO_MS, "the caller hears each sentence once");
  assert.deepEqual(
    ttsMetrics.map((m) => m.charactersCount).sort((a, b) => a - b),
    [...SENTENCES.map((s) => s.length), REPLY.length].sort((a, b) => a - b),
  );
  const rows = await ledger();
  assert.equal(rows.characters.quantity, SENTENCES.join("").length + REPLY.length);
  // The adapter meters the audio of the sentences done at its first final frame, as well.
  assert.ok(rows.milliseconds.quantity > REPLY_AUDIO_MS);
});

test("buildPipelineTts gives a google agent Gemini TTS behind a streaming TTS with the plugin's label", () => {
  const { built } = builtGemini();
  assert.ok(built instanceof SentenceStreamTTS);
  assert.ok(built.inner instanceof google.beta.TTS);
  assert.equal(built.capabilities.streaming, true, "so the SDK does not wrap it in tts.StreamAdapter");
  assert.equal(built.capabilities.alignedTranscript, undefined, "transcripts follow the LLM text, as before");
  assert.equal(built.label, "google.gemini.TTS");
  assert.equal(built.sampleRate, SAMPLE_RATE);

  const keys = { GOOGLE_API_KEY: "k", DEEPGRAM_API_KEY: "k", LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: "true" };
  const { session } = withEnv(keys, () =>
    createVoiceModelAndSession({
      voiceMode: "pipeline",
      modelName: "livekit:google/gemini-2.5-flash",
      agent: agent({ vendor: "google", voice: "Kore" }),
      call: { id: "call-1" } as any,
      tools: {} as any,
    }),
  );
  assert.ok((session as any).tts instanceof SentenceStreamTTS);
});

test("a Gemini TTS session meters each reply once, with its characters and all its audio", async () => {
  const { built, requests } = builtGemini();

  const { sink, ttsMetrics, ledger } = await speakOnSession(built, REPLY, { replies: 2 });
  await until(() => ttsMetrics.length >= 2, "the metrics");
  await settle();

  assert.deepEqual(requests, [...SENTENCES, ...SENTENCES]);
  assert.equal(framesMs(sink.frames), 2 * REPLY_AUDIO_MS);
  assert.equal(ttsMetrics.length, 2, "one metrics event per reply");
  for (const m of ttsMetrics) {
    assert.equal(m.charactersCount, REPLY.length);
    assert.equal(m.audioDurationMs, REPLY_AUDIO_MS);
    assert.equal(m.label, "google.gemini.TTS");
  }
  assert.deepEqual(await ledger(), {
    characters: { quantity: 2 * REPLY.length, provider: "google", detail: "google.gemini.TTS" },
    milliseconds: { quantity: 2 * REPLY_AUDIO_MS, provider: "google", detail: "google.gemini.TTS" },
  });
});

test("Gemini TTS usage is billed to google with or without a voice, never to the Cartesia default", async () => {
  for (const ttsOptions of [{ vendor: "google" }, { vendor: "google", voice: "Kore" }]) {
    const { built } = builtGemini({}, ttsOptions);
    assert.equal((built.inner as google.beta.TTS).opts.voiceName, "Kore");
    const usageVendors = withEnv({ LIVEKIT_PIPELINE_GOOGLE_TTS: undefined }, () =>
      resolveUsageVendors(agent(ttsOptions), "livekit:openai/gpt-4o-mini"),
    );

    const { ttsMetrics, ledger } = await speakOnSession(built, REPLY, { usageVendors });
    await until(() => ttsMetrics.length >= 1, "the metrics");
    await settle();

    assert.deepEqual(
      await ledger(),
      {
        characters: { quantity: REPLY.length, provider: "google", detail: "google.gemini.TTS" },
        milliseconds: { quantity: REPLY_AUDIO_MS, provider: "google", detail: "google.gemini.TTS" },
      },
      JSON.stringify(ttsOptions),
    );
  }
});

test("with LIVEKIT_PIPELINE_GOOGLE_TTS, a google agent without a voice is billed for the TTS it is built with", () => {
  const voiceless = agent({ vendor: "google" });
  withEnv({ LIVEKIT_PIPELINE_GOOGLE_TTS: "google/custom-tts:narrator" }, () => {
    assert.equal(buildPipelineTts(voiceless), "google/custom-tts:narrator");
    assert.equal(resolvePipelineTts(voiceless), "google/custom-tts:narrator");
    assert.deepEqual(resolveUsageVendors(voiceless, "livekit:openai/gpt-4o-mini").tts, {
      vendor: "google",
      detail: "google/custom-tts",
    });
  });
});

test("a reply the caller interrupts while the LLM is still streaming is metered once", async () => {
  const { built } = builtGemini();
  const sink = new FakeAudioOutput();

  const { ttsMetrics, ledger } = await onSession(
    built,
    async (session, metrics) => {
      const reply = session.generateReply({ userInput: "Hello" });
      await until(() => sink.frames.length > 0, "the first audio");
      reply.interrupt();
      await until(() => metrics.length > 0, "the metrics");
      await settle();
    },
    { sink, llm: new WordByWordLLM() },
  );

  assert.equal(ttsMetrics.length, 1);
  // The text the LLM had sent by then: past the first sentence, short of the whole reply.
  const chars = ttsMetrics[0].charactersCount;
  assert.ok(chars > SENTENCES[0].length && chars < REPLY.length, `metered ${chars} characters`);
  assert.equal((await ledger()).characters.quantity, chars);
});

test("sentences are requested as they complete and played in order", async () => {
  // The first sentence is answered last, so the order has to come from the stream.
  const { built, requests } = builtGemini({ delayMs: (n) => (n === 1 ? 100 : 0) });
  const sink = new FakeAudioOutput();
  let requestedBeforeFirstAudio = 0;
  sink.onFirstFrame = () => (requestedBeforeFirstAudio = requests.length);

  await speakOnSession(built, REPLY, { sink });

  assert.equal(requestedBeforeFirstAudio, SENTENCES.length, "later sentences are not held behind the first");
  assert.deepEqual(playoutOrder(sink.frames), [1, 2, 3]);
});

test("replies add no listeners to the Gemini TTS", async () => {
  const raw = rawGemini();
  stubGemini(raw);
  await speakOnSession(raw, REPLY, { replies: 3 });
  // tts.StreamAdapter adds two per reply and never removes them.
  assert.ok(raw.listenerCount("metrics_collected") >= 3);

  const { built } = builtGemini();
  await speakOnSession(built, REPLY, { replies: 3 });
  assert.equal(built.inner.listenerCount("metrics_collected"), 0);
  assert.equal(built.inner.listenerCount("error"), 1);
});

test("a sentence that fails is an error on the TTS the session listens to, and the reply goes on", async () => {
  const { built, requests } = builtGemini({
    fail: (n) => (n === 2 ? Object.assign(new Error("Bad request"), { code: 400 }) : undefined),
  });
  const errors: any[] = [];
  const metrics: any[] = [];
  built.on("error", (e) => errors.push(e));
  built.on("metrics_collected", (m) => metrics.push(m));

  let frames: AudioFrame[] = [];
  const caught = await withJobRejectionHandler(async () => {
    const s = built.stream();
    s.updateInputStream(textStream([REPLY]));
    frames = await collect(s);
  });

  assert.deepEqual(requests, SENTENCES, "a 400 is not retried");
  assert.deepEqual(playoutOrder(frames), [1, 3]);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].error instanceof APIStatusError);
  assert.equal(errors[0].error.statusCode, 400);
  assert.equal(errors[0].recoverable, false);
  assert.ok(caught.every((r) => r instanceof APIStatusError));
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].charactersCount, REPLY.length);
});

test("closing a stream mid-reply cancels the sentence in flight and asks for no more, quietly", async () => {
  const aborted: number[] = [];
  const { built, requests } = builtGemini({ delayMs: (n) => (n === 1 ? 0 : 500) });
  const inner = built.inner as google.beta.TTS;
  const stubbed = (inner.client.models as any).generateContentStream;
  (inner.client.models as any).generateContentStream = (params: any) => {
    const n = requests.length + 1;
    params.config.abortSignal.addEventListener("abort", () => aborted.push(n));
    return stubbed(params);
  };
  const errors: unknown[] = [];
  built.on("error", (e) => errors.push(e));

  let reply!: ReadableStreamDefaultController<string>;
  const s = built.stream();
  s.updateInputStream(new ReadableStream<string>({ start: (c) => void (reply = c) }));
  // The LLM is still replying. The tokenizer releases a sentence once the next one starts.
  reply.enqueue(`${SENTENCES[0]} ${SENTENCES[1]} What`);
  for await (const ev of s) {
    if (ev !== tts.SynthesizeStream.END_OF_STREAM) break;
  }
  s.close();
  reply.enqueue(" would you like to do today? Goodbye.");
  await new Promise((r) => setTimeout(r, 100));

  assert.deepEqual(requests, SENTENCES.slice(0, 2));
  assert.ok(aborted.includes(2), "the second sentence's request is cancelled");
  assert.deepEqual(errors, []);
});

test("synthesize() still sends the whole text in one request", async () => {
  const { built, requests } = builtGemini();
  const frame = await built.synthesize(REPLY).collect();
  assert.deepEqual(requests, [REPLY]);
  assert.equal(Math.round((frame.samplesPerChannel / frame.sampleRate) * 1000), audioMs(REPLY));
});
