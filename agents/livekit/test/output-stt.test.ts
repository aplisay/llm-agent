import { test } from "node:test";
import assert from "node:assert/strict";
import { stt } from "@livekit/agents";
import { OUTPUT_STT_LOG_TYPE, OUTPUT_STT_TECHNOLOGY, armOutputStt, teeAudioOutput } from "../lib/output-stt.js";
import { outputSttAgent, parseOutputSttOption, resolveOutputSttVendor, startSideSttEngine } from "../lib/aux-stt.js";

// The output audit: option parsing, the agent-side language order, and the
// AudioOutput tee driven with a fake session output and a fake STT engine.
// run: tsx --test test/output-stt.test.ts

test("constants match the platform contract", () => {
  assert.equal(OUTPUT_STT_LOG_TYPE, "agent-speech");
  assert.equal(OUTPUT_STT_TECHNOLOGY, "stt-output");
});

test("parseOutputSttOption reads options.tts.output with the shared leniency", () => {
  assert.equal(parseOutputSttOption(undefined), null);
  assert.equal(parseOutputSttOption({ tts: { voice: "Ciara" } }), null);
  assert.equal(parseOutputSttOption({ tts: { output: false } }), null);
  assert.equal(parseOutputSttOption({ tts: { output: { enabled: false } } }), null);
  assert.deepEqual(parseOutputSttOption({ tts: { output: true } }), {});
  assert.deepEqual(parseOutputSttOption({ tts: { output: { vendor: " deepgram ", language: "en-GB" } } }), {
    vendor: "deepgram",
    language: "en-GB",
  });
});

test("outputSttAgent: the agent speaks in its TTS language, so tts.language wins", () => {
  const agent = { id: "a", options: { tts: { voice: "Ciara", language: "en-GB", output: {} }, stt: { language: "fr" } } } as any;
  assert.deepEqual(outputSttAgent(agent, { vendor: "deepgram" }).options.stt, { vendor: "deepgram", language: "en-GB" });
  assert.deepEqual(outputSttAgent({ id: "b", options: { stt: { language: "fr" } } } as any, {}).options.stt, { language: "fr" });
  assert.deepEqual(resolveOutputSttVendor(agent, {}), { vendor: "deepgram", detail: "deepgram/nova-3" });
});

// ---- fakes ----------------------------------------------------------------

class FakeSpeechStream {
  pushed: any[] = [];
  flushes = 0;
  private queue: any[] = [];
  private waiters: Array<(r: IteratorResult<any>) => void> = [];
  private ended = false;
  constructor(private readonly finalAfterFrames: number, private readonly text: string) {}
  flush() {
    this.flushes += 1;
  }
  pushFrame(frame: any) {
    if (this.ended) throw new Error("input ended");
    this.pushed.push(frame);
    if (this.pushed.length === this.finalAfterFrames) {
      this.put({ type: stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives: [{ text: this.text }] });
    }
  }
  private put(ev: any) {
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.queue.push(ev);
  }
  endInput() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  close() {
    this.endInput();
  }
  next(): Promise<IteratorResult<any>> {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((r) => this.waiters.push(r));
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}

function fakeStt(stream: FakeSpeechStream, closed: { n: number }) {
  const handlers = new Map<string, Set<(ev: any) => void>>();
  return {
    label: "fake.STT",
    stream: () => stream,
    close: async () => void closed.n++,
    on(evt: string, cb: (ev: any) => void) {
      (handlers.get(evt) ?? handlers.set(evt, new Set()).get(evt)!).add(cb);
    },
    off(evt: string, cb: (ev: any) => void) {
      handlers.get(evt)?.delete(cb);
    },
    emit(evt: string, ev: any) {
      for (const cb of handlers.get(evt) ?? []) cb(ev);
    },
  } as any;
}

/** A stand-in for the SDK's ParticipantAudioOutput: records frames, has a getter, a method and events. */
class FakeParticipantOutput {
  frames: any[] = [];
  flushed = 0;
  listeners: string[] = [];
  private readonly _rate = 24000;
  get sampleRate() {
    return this._rate;
  }
  async captureFrame(frame: any) {
    this.frames.push(frame);
  }
  flush() {
    this.flushed += 1;
  }
  waitForPlayout() {
    return "played";
  }
  on(evt: string) {
    this.listeners.push(evt);
    return this;
  }
}

const frame = (n: number) => ({ sampleRate: 16000, samplesPerChannel: 320, channels: 1, n }) as any;
const settle = () => new Promise((r) => setTimeout(r, 30));

test("teeAudioOutput: intercepts captureFrame only; everything else is the original's, bound", async () => {
  const original = new FakeParticipantOutput();
  const stream = new FakeSpeechStream(2, " thank you for calling ");
  const closed = { n: 0 };
  const transcripts: string[] = [];
  const engine = startSideSttEngine({
    label: "outputStt",
    roomName: "r",
    subject: "agent output",
    stt: fakeStt(stream, closed),
    onTranscript: (t) => transcripts.push(t),
    onUsage: () => {},
  });
  const tee = teeAudioOutput(original as any, engine) as any;
  await tee.captureFrame(frame(1));
  await tee.captureFrame(frame(2));
  await settle();
  assert.deepEqual(original.frames.map((f) => f.n), [1, 2], "frames reach the real output, in order");
  assert.deepEqual(stream.pushed.map((f) => f.n), [1, 2], "…and the engine");
  assert.deepEqual(transcripts, ["thank you for calling"]);
  assert.equal(tee.sampleRate, 24000, "getters read through");
  assert.equal(tee.waitForPlayout(), "played", "methods bound to the original");
  tee.flush();
  assert.equal(original.flushed, 1);
  tee.on("playbackFinished");
  assert.deepEqual(original.listeners, ["playbackFinished"], "event registration lands on the original");
  assert.ok(tee instanceof FakeParticipantOutput, "instanceof still holds");
  await engine.dispose();
  assert.equal(closed.n, 1);
});

test("armOutputStt: installs the tee, logs finals, meters the engine's report, restores on dispose", async () => {
  const original = new FakeParticipantOutput();
  const session = { output: { audio: original as any } };
  const stream = new FakeSpeechStream(3, "hello, this is the agent");
  const closed = { n: 0 };
  const engineStt = fakeStt(stream, closed);
  const transcripts: string[] = [];
  const usage: Record<string, number> = { milliseconds: 0, characters: 0 };
  const handle = armOutputStt({
    session,
    roomName: "r",
    agent: { id: "a", options: {} } as any,
    config: {},
    onTranscript: (t) => transcripts.push(t),
    onUsage: (unit, q) => (usage[unit] += q),
    deps: { buildStt: () => engineStt },
  });
  assert.equal(handle.installed, true);
  assert.notEqual(session.output.audio, original, "the tee is now the session's output");
  for (let i = 1; i <= 3; i++) await (session.output.audio as any).captureFrame(frame(i));
  await settle();
  assert.equal(original.frames.length, 3, "playout unaffected");
  assert.deepEqual(transcripts, ["hello, this is the agent"]);
  assert.equal(usage.characters, "hello, this is the agent".length);
  assert.equal(Math.round(handle.usage.streamedMilliseconds), 60);
  assert.equal(usage.milliseconds, 0, "nothing metered until the engine reports");
  engineStt.emit("metrics_collected", { type: "stt_metrics", audioDurationMs: 1200 });
  assert.equal(usage.milliseconds, 1200);
  await handle.dispose();
  assert.equal(session.output.audio, original, "original output restored");
  assert.equal(stream.flushes, 1, "engine asked for its last usage interval");
  assert.equal(closed.n, 1);
  await handle.dispose();
  assert.equal(closed.n, 1, "idempotent");
});

test("armOutputStt: leaves the session untouched when there is no output or the engine cannot be built", async () => {
  const none = { output: { audio: null } };
  const h1 = armOutputStt({
    session: none,
    roomName: "r",
    agent: { id: "a", options: {} } as any,
    config: {},
    onTranscript: () => assert.fail("no transcript"),
    onUsage: () => assert.fail("no usage"),
    deps: { buildStt: () => assert.fail("must not build without an output") },
  });
  assert.equal(h1.installed, false);
  assert.equal(none.output.audio, null);
  await h1.dispose();

  const original = new FakeParticipantOutput();
  const session = { output: { audio: original as any } };
  const h2 = armOutputStt({
    session,
    roomName: "r",
    agent: { id: "a", options: {} } as any,
    config: { vendor: "nope" },
    onTranscript: () => {},
    onUsage: () => {},
    deps: {
      buildStt: () => {
        throw new Error("no such vendor");
      },
    },
  });
  assert.equal(h2.installed, false);
  assert.equal(session.output.audio, original, "no tee installed");
  await h2.dispose();
});

test("armOutputStt: a non-recoverable engine error uninstalls the tee", async () => {
  const original = new FakeParticipantOutput();
  const session = { output: { audio: original as any } };
  const closed = { n: 0 };
  const engineStt = fakeStt(new FakeSpeechStream(99, "never"), closed);
  armOutputStt({
    session,
    roomName: "r",
    agent: { id: "a", options: {} } as any,
    config: {},
    onTranscript: () => {},
    onUsage: () => {},
    deps: { buildStt: () => engineStt },
  });
  assert.notEqual(session.output.audio, original);
  engineStt.emit("error", { type: "stt_error", label: "deepgram.STT", recoverable: false, error: new Error("gave up") });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(session.output.audio, original, "original restored after the engine stopped itself");
  assert.equal(closed.n, 1);
});
