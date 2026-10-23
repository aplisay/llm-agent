import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { APIError, APIStatusError, APITimeoutError, initializeLogger, tts } from "@livekit/agents";
import {
  NeuphonicTTS,
  SILENCE_MARGIN_MS,
  SILENCE_THRESHOLD,
  buildNeuphonicTts,
  trimLeadingSilence,
} from "../lib/neuphonic-tts.js";
import { buildPipelineTts } from "../lib/voice-session-factory.js";
import { resolvePipelineTts } from "../lib/pipeline-inference-options.js";
import { resolveUsageVendors } from "../lib/usage-vendors.js";
import { textOutputEnabled } from "../lib/realtime-tts.js";

// Neuphonic TTS on the LiveKit worker (docs/neuphonic.md) against a local stand-in for the SSE endpoint.
// run: node --import tsx --test test/neuphonic-tts.test.ts

initializeLogger({ pretty: false, level: "fatal" });

type Scenario = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;
const requests: { path: string; key: string | undefined; body: Record<string, unknown> }[] = [];
let scenario: Scenario = () => {};

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    requests.push({ path: req.url || "", key: req.headers["x-api-key"] as string | undefined, body });
    scenario(req, res, body);
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

/** 100 ms of distinct 16-bit samples at 22050 Hz, so frames can be compared byte for byte. */
const pcm = (seed: number) => {
  const samples = new Int16Array(2205);
  samples.forEach((_, i) => (samples[i] = ((i * 7 + seed * 131) % 2000) - 1000));
  return Buffer.from(samples.buffer);
};
const audioEvent = (bytes: Buffer) =>
  `event: message\ndata: ${JSON.stringify({ status_code: 200, data: { audio: bytes.toString("base64"), sampling_rate: 22050 } })}\n\n`;
const errorEvent = `event: error\ndata: {"status_code": 500, "errors": ["Internal server error"]}\n\n`;

function sse(res: ServerResponse, chunks: string[]) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) res.write(c);
  res.end();
}

/** `ms` of digital silence at 22050 Hz. */
const silence = (ms: number) => Buffer.alloc(2 * Math.round((22050 * ms) / 1000));
/** Samples kept before the first loud one at 22050 Hz. */
const MARGIN = Math.floor((22050 * SILENCE_MARGIN_MS) / 1000);

const frameBytes = (frames: { data: Int16Array }[]) =>
  Buffer.concat(frames.map((f) => Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength)));

const makeTts = (opts: Partial<ConstructorParameters<typeof NeuphonicTTS>[0]> = {}) =>
  new NeuphonicTTS({ apiKey: "test-key", voiceId: "voice-1", langCode: "de", baseURL, ...opts });

const fastRetry = { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 2000 };

/**
 * A stream that gives up leaves a rejected promise behind in agents-js 1.0.46, which the job process
 * logs (ipc/job_proc_lazy_main.js). Stand in for that handler while `fn` runs; return what it caught.
 */
async function withJobRejectionHandler(fn: () => Promise<void>): Promise<unknown[]> {
  const runner = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const caught: unknown[] = [];
  const handler = (reason: unknown) => caught.push(reason);
  process.on("unhandledRejection", handler);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off("unhandledRejection", handler);
    runner.forEach((l) => process.on("unhandledRejection", l));
  }
  return caught;
}

async function collect(stream: AsyncIterable<unknown>) {
  const frames: { data: Int16Array; sampleRate: number }[] = [];
  for await (const ev of stream) {
    if (ev === tts.SynthesizeStream.END_OF_STREAM) break;
    frames.push((ev as { frame: { data: Int16Array; sampleRate: number } }).frame);
  }
  return frames;
}

test("synthesize posts the text to /sse/speak/<lang> and returns the decoded audio", async () => {
  requests.length = 0;
  scenario = (_req, res) => sse(res, [audioEvent(pcm(1)), audioEvent(pcm(2))]);
  const frames = await collect(makeTts().synthesize("Guten Tag."));
  assert.deepEqual(frameBytes(frames), Buffer.concat([pcm(1), pcm(2)]));
  assert.ok(frames.every((f) => f.sampleRate === 22050));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, "/sse/speak/de");
  assert.equal(requests[0]!.key, "test-key");
  assert.deepEqual(requests[0]!.body, {
    text: "Guten Tag.",
    lang_code: "de",
    sampling_rate: 22050,
    encoding: "pcm_linear",
    voice_id: "voice-1",
  });
});

test("no voice sends no voice_id, so Neuphonic uses its default for the language", async () => {
  requests.length = 0;
  scenario = (_req, res) => sse(res, [audioEvent(pcm(1))]);
  await collect(makeTts({ voiceId: undefined, langCode: "es" }).synthesize("Hola."));
  assert.equal(requests[0]!.path, "/sse/speak/es");
  assert.equal("voice_id" in requests[0]!.body, false);
});

test("events split at any byte boundary, with CRLF line ends, still parse", async () => {
  const body = (audioEvent(pcm(3)) + audioEvent(pcm(4))).replace(/\n/g, "\r\n");
  scenario = (_req, res) => sse(res, body.split(""));
  const frames = await collect(makeTts().synthesize("Hallo."));
  assert.deepEqual(frameBytes(frames), Buffer.concat([pcm(3), pcm(4)]));
});

test("an error event inside an HTTP 200 stream is a retryable status error", async () => {
  requests.length = 0;
  scenario = (_req, res) => sse(res, [errorEvent]);
  const t = makeTts();
  const errors: unknown[] = [];
  t.on("error", (e) => errors.push(e.error));
  let frames: unknown[] = [];
  const caught = await withJobRejectionHandler(async () => {
    frames = await collect(t.synthesize("Hallo.", fastRetry));
  });
  assert.equal(frames.length, 0);
  assert.equal(requests.length, 2, "one retry");
  assert.ok(errors[0] instanceof APIStatusError);
  assert.equal((errors[0] as APIStatusError).statusCode, 500);
  assert.ok(caught.every((r) => r instanceof APIError));
});

test("an HTTP 4xx is not retried", async () => {
  requests.length = 0;
  scenario = (_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"detail":"No API Key or JWT token provided."}');
  };
  const t = makeTts();
  const errors: unknown[] = [];
  t.on("error", (e) => errors.push(e.error));
  const caught = await withJobRejectionHandler(async () => {
    await collect(t.synthesize("Hallo.", fastRetry));
  });
  assert.equal(requests.length, 1);
  assert.ok(errors[0] instanceof APIStatusError);
  assert.equal((errors[0] as APIStatusError).statusCode, 401);
  assert.ok(caught.every((r) => r instanceof APIError));
});

test("no audio within timeoutMs is a timeout, retried", async () => {
  requests.length = 0;
  scenario = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    setTimeout(() => res.end(), 1000);
  };
  const t = makeTts();
  const errors: unknown[] = [];
  t.on("error", (e) => errors.push(e.error));
  const caught = await withJobRejectionHandler(async () => {
    await collect(t.synthesize("Hallo.", { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 150 }));
  });
  assert.equal(requests.length, 2);
  assert.ok(errors[0] instanceof APITimeoutError);
  assert.ok(caught.every((r) => r instanceof APIError));
});

test("an error after audio has gone out is not retried, so no audio repeats", async () => {
  requests.length = 0;
  scenario = (_req, res) => sse(res, [audioEvent(pcm(5)), errorEvent]);
  const t = makeTts();
  const errors: unknown[] = [];
  t.on("error", (e) => errors.push(e.error));
  let frames: { data: Int16Array }[] = [];
  const caught = await withJobRejectionHandler(async () => {
    frames = await collect(t.synthesize("Hallo.", fastRetry));
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(frameBytes(frames), pcm(5));
  assert.equal((errors[0] as APIError).retryable, false);
  assert.ok(caught.every((r) => r instanceof APIError));
});

test("a sentence that still fails after its retry ends the reply with one error", async () => {
  requests.length = 0;
  scenario = (_req, res) => sse(res, [errorEvent]);
  const t = makeTts({ langCode: "en" });
  const errors: { recoverable: boolean }[] = [];
  t.on("error", (e) => errors.push(e as { recoverable: boolean }));
  let frames: unknown[] = [];
  const caught = await withJobRejectionHandler(async () => {
    const s = t.stream({ connOptions: fastRetry });
    s.updateInputStream(new ReadableStream({ start(c) { c.enqueue("This sentence cannot be spoken. "); c.close(); } }));
    frames = await collect(s);
  });
  assert.equal(frames.length, 0);
  assert.equal(requests.length, 2, "one retry for the sentence, none for the reply");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.recoverable, false);
  assert.ok(caught.every((r) => r instanceof APIError));
});

test("stream() asks for one sentence at a time, plays them in order and meters the reply once", async () => {
  requests.length = 0;
  let n = 0;
  scenario = (_req, res) => {
    const seed = ++n;
    // Answer the first sentence last, so ordering comes from the stream, not the network.
    setTimeout(() => sse(res, [audioEvent(pcm(seed))]), seed === 1 ? 150 : 0);
  };
  const t = makeTts({ langCode: "en" });
  const metrics: { charactersCount: number }[] = [];
  t.on("metrics_collected", (m) => metrics.push(m as { charactersCount: number }));
  const text = ["Thanks for calling today. ", "Could you tell me your booking reference? ", "It is on the email."];
  const s = t.stream({ connOptions: fastRetry });
  s.updateInputStream(new ReadableStream({ start(c) { text.forEach((t) => c.enqueue(t)); c.close(); } }));
  const frames = await collect(s);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((r) => r.body.text), text.map((t) => t.trim()));
  assert.deepEqual(frameBytes(frames), Buffer.concat([pcm(1), pcm(2), pcm(3)]));
  assert.equal(metrics.length, 1, "one metrics event per reply, not one per sentence as well");
  assert.equal(metrics[0]!.charactersCount, text.join("").length);
});

test("closing a stream mid-reply stops it quietly", async () => {
  requests.length = 0;
  scenario = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(audioEvent(pcm(1)));
    setTimeout(() => { if (!res.writableEnded) res.end(audioEvent(pcm(2))); }, 500);
  };
  const t = makeTts({ langCode: "en" });
  const errors: unknown[] = [];
  t.on("error", (e) => errors.push(e));
  const s = t.stream({ connOptions: fastRetry });
  // The input stays open, as it does while the LLM is still replying. The tokenizer releases a
  // sentence once the next one starts.
  s.updateInputStream(new ReadableStream({
    start(c) { c.enqueue("A first sentence that is long enough. And the next one starts"); },
  }));
  for await (const ev of s) {
    if (ev !== tts.SynthesizeStream.END_OF_STREAM) break;
  }
  s.close();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(requests.length, 1);
  assert.deepEqual(errors, []);
});

async function trimmed(chunks: Uint8Array[]) {
  async function* source() {
    yield* chunks;
  }
  const out: Uint8Array[] = [];
  for await (const c of trimLeadingSilence(source(), 22050)) out.push(c);
  return Buffer.concat(out);
}

/** Buffer comparison that fails with a short message: deepEqual's diff of large buffers exhausts the heap. */
function sameBytes(actual: Buffer, expected: Buffer, what = "audio") {
  assert.equal(actual.length / 2, expected.length / 2, `${what}: samples`);
  assert.ok(actual.equals(expected), `${what}: sample values differ`);
}

/** `bytes` in chunks of the given sizes, the last size repeating. */
function split(bytes: Buffer, ...sizes: number[]) {
  const chunks: Buffer[] = [];
  for (let at = 0, i = 0; at < bytes.length; i++) {
    const n = sizes[Math.min(i, sizes.length - 1)]!;
    chunks.push(bytes.subarray(at, at + n));
    at += n;
  }
  return chunks;
}

const hiss = (samples: number) =>
  Array.from({ length: samples }, (_, i) => (i % 2 ? SILENCE_THRESHOLD : -SILENCE_THRESHOLD));

/**
 * 400 ms of hiss at the threshold, a soft onset whose first sample over the threshold is negative,
 * 300 ms of silence, then more speech. `onset` indexes the first sample over the threshold.
 */
function utterance() {
  const lead = hiss(8820);
  const soft = [40, -80, 120, -160, 200, -(SILENCE_THRESHOLD + 1), 3000, -3000];
  const loud = Array.from({ length: 2205 }, (_, i) => (i % 2 ? 5000 : -5000));
  const values = [...lead, ...soft, ...new Array(6615).fill(0), ...loud];
  return { bytes: Buffer.from(Int16Array.from(values).buffer), onset: lead.length + 5 };
}

test("trimLeadingSilence keeps 50 ms before the first sample over the threshold, and all that follows", async () => {
  const { bytes, onset } = utterance();
  sameBytes(await trimmed(split(bytes, 4410)), bytes.subarray(2 * (onset - MARGIN)));
});

test("a chunk boundary inside a sample does not move the cut", async () => {
  const { bytes, onset } = utterance();
  for (const sizes of [[1], [3], [17601, 1, 4410], [bytes.length]]) {
    sameBytes(await trimmed(split(bytes, ...sizes)), bytes.subarray(2 * (onset - MARGIN)), `chunks of ${sizes}`);
  }
});

test("audio that starts loud, gets loud within the margin, or never gets loud passes through whole", async () => {
  sameBytes(await trimmed(split(pcm(1), 1000)), pcm(1), "loud from the start");
  const early = Buffer.concat([silence(30), pcm(1)]);
  sameBytes(await trimmed(split(early, 1000)), early, "loud after 30 ms");
  const quiet = Buffer.from(Int16Array.from(hiss(22050)).buffer);
  sameBytes(await trimmed(split(quiet, 4410)), quiet, "never loud");
  sameBytes(await trimmed([]), Buffer.alloc(0), "empty");
});

test("synthesize drops the silence Neuphonic starts with, and keeps later pauses and the tail", async () => {
  scenario = (_req, res) =>
    sse(res, [audioEvent(silence(400)), audioEvent(pcm(1)), audioEvent(silence(100)), audioEvent(pcm(2)), audioEvent(silence(200))]);
  const frames = await collect(makeTts().synthesize("Guten Tag. Wie geht es Ihnen?"));
  sameBytes(frameBytes(frames), Buffer.concat([Buffer.alloc(2 * MARGIN), pcm(1), silence(100), pcm(2), silence(200)]));
});

test("stream() trims each sentence on its own and keeps the silence inside it", async () => {
  const leads = [300, 800, 0];
  let n = 0;
  scenario = (_req, res) => {
    const i = n++;
    const body = [silence(leads[i]!), pcm(i + 1), silence(150), pcm(i + 11), silence(250)];
    sse(res, body.map(audioEvent));
  };
  const t = makeTts({ langCode: "en" });
  const s = t.stream({ connOptions: fastRetry });
  const text = ["Thanks for calling today. ", "Could you tell me your booking reference? ", "It is on the email."];
  s.updateInputStream(new ReadableStream({ start(c) { text.forEach((t) => c.enqueue(t)); c.close(); } }));
  const frames = await collect(s);
  const kept = (ms: number) => Buffer.alloc(Math.min(silence(ms).length, 2 * MARGIN));
  const expected = leads.flatMap((ms, i) => [kept(ms), pcm(i + 1), silence(150), pcm(i + 11), silence(250)]);
  sameBytes(frameBytes(frames), Buffer.concat(expected));
});

test("a sentence that fails while only silence has arrived is retried, and none of it plays twice", async () => {
  requests.length = 0;
  let n = 0;
  scenario = (_req, res) =>
    sse(res, n++ === 0 ? [audioEvent(silence(300)), errorEvent] : [audioEvent(silence(300)), audioEvent(pcm(1))]);
  const t = makeTts({ langCode: "en" });
  const s = t.stream({ connOptions: fastRetry });
  s.updateInputStream(new ReadableStream({ start(c) { c.enqueue("Just the one sentence."); c.close(); } }));
  const frames = await collect(s);
  assert.equal(requests.length, 2);
  sameBytes(frameBytes(frames), Buffer.concat([Buffer.alloc(2 * MARGIN), pcm(1)]));
});

test("a missing key is refused at construction", () => {
  assert.throws(() => new NeuphonicTTS({ apiKey: "" }), /NEUPHONIC_API_KEY/);
});

const agent = (ttsOpts: Record<string, unknown>, stt?: Record<string, unknown>) =>
  ({ options: { tts: ttsOpts, ...(stt ? { stt } : {}) } }) as never;

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.entries(env).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  try {
    return fn();
  } finally {
    Object.entries(saved).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  }
}

test("buildPipelineTts builds Neuphonic directly, with or without provider-key mode", () => {
  for (const useKeys of [undefined, "true"]) {
    withEnv({ NEUPHONIC_API_KEY: "k", LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: useKeys }, () => {
      const built = buildPipelineTts(agent({ vendor: "neuphonic", voice: "neuphonic:abc-123", language: "pt-BR" }));
      assert.ok(built instanceof NeuphonicTTS);
      assert.deepEqual((built as NeuphonicTTS).options, {
        voiceId: "abc-123",
        langCode: "pt",
        sampleRate: 22050,
        baseURL: "https://api.neuphonic.com",
      });
      assert.equal((built as NeuphonicTTS).capabilities.streaming, true);
    });
  }
  withEnv({ NEUPHONIC_API_KEY: "k" }, () => {
    assert.ok(buildPipelineTts(agent({ vendor: "Neuphonic/any-model", voice: "v" })) instanceof NeuphonicTTS);
  });
});

test("language falls back to options.stt, and a non-specific tag to English", () => {
  withEnv({ NEUPHONIC_API_KEY: "k" }, () => {
    assert.equal(buildNeuphonicTts(agent({ vendor: "neuphonic" }, { language: "fr-FR" })).options.langCode, "fr");
    assert.equal(buildNeuphonicTts(agent({ vendor: "neuphonic" }, { language: "multi" })).options.langCode, "en");
    assert.equal(buildNeuphonicTts(agent({ vendor: "neuphonic" })).options.langCode, "en");
  });
});

test("a worker without NEUPHONIC_API_KEY fails with the variable named", () => {
  withEnv({ NEUPHONIC_API_KEY: undefined }, () => {
    assert.throws(() => buildPipelineTts(agent({ vendor: "neuphonic", voice: "v" })), /NEUPHONIC_API_KEY/);
  });
});

test("usage is billed to neuphonic, never to the Cartesia default", () => {
  const withVoice = agent({ vendor: "neuphonic", voice: "abc-123" });
  assert.equal(resolvePipelineTts(withVoice), "neuphonic:abc-123");
  assert.deepEqual(resolveUsageVendors(withVoice, "livekit:openai/gpt-4o").tts, { vendor: "neuphonic", detail: "neuphonic" });
  // Without a voice the generic path would fall back to the Cartesia default.
  const voiceless = agent({ vendor: "neuphonic" });
  assert.equal(resolvePipelineTts(voiceless), "neuphonic");
  assert.equal(resolveUsageVendors(voiceless, "livekit:openai/gpt-4o").tts.vendor, "neuphonic");
});

test("Neuphonic is an external TTS on the text-output realtime rows", () => {
  const ext = agent({ vendor: "neuphonic", voice: "abc-123" });
  assert.equal(textOutputEnabled(ext, "livekit:ultravox/ultravox-v0.7"), true);
  assert.equal(textOutputEnabled(ext, "livekit:openai/gpt-realtime"), true);
  assert.equal(textOutputEnabled(ext, "livekit:google/gemini-2.5-flash-native-audio-preview-12-2025"), false);
});
