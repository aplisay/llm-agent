import { test } from "node:test";
import assert from "node:assert/strict";
import { stt } from "@livekit/agents";
import {
  AUX_STT_LOG_TYPE,
  AUX_STT_TECHNOLOGY,
  armAuxStt,
  auxSttAgent,
  parseAuxSttOption,
  resolveAuxSttVendor,
} from "../lib/aux-stt.js";

// Option parser, vendor resolution and the arm/pump loop for options.stt.aux,
// driven with a fake room, track, audio source and STT (no SDK connections).
// run: tsx --test test/aux-stt.test.ts

test("constants match the platform contract", () => {
  assert.equal(AUX_STT_LOG_TYPE, "user-aux");
  assert.equal(AUX_STT_TECHNOLOGY, "stt-aux");
});

test("parseAuxSttOption: absent/false/disabled/malformed give null", () => {
  assert.equal(parseAuxSttOption(undefined), null);
  assert.equal(parseAuxSttOption({}), null);
  assert.equal(parseAuxSttOption({ stt: {} }), null);
  assert.equal(parseAuxSttOption({ stt: { aux: false } }), null);
  assert.equal(parseAuxSttOption({ stt: { aux: null } }), null);
  assert.equal(parseAuxSttOption({ stt: { aux: { enabled: false, vendor: "assemblyai" } } }), null);
  // Malformed shapes are off, not errors (the server validates at save time).
  assert.equal(parseAuxSttOption({ stt: { aux: "yes" } }), null);
  assert.equal(parseAuxSttOption({ stt: { aux: ["deepgram"] } }), null);
});

test("parseAuxSttOption: true / {} / object normalise", () => {
  assert.deepEqual(parseAuxSttOption({ stt: { aux: true } }), {});
  assert.deepEqual(parseAuxSttOption({ stt: { aux: {} } }), {});
  assert.deepEqual(parseAuxSttOption({ stt: { aux: { enabled: true } } }), {});
  assert.deepEqual(
    parseAuxSttOption({ stt: { aux: { vendor: " assemblyai ", language: "en-GB" } } }),
    { vendor: "assemblyai", language: "en-GB" },
  );
  // Blank strings are "unset".
  assert.deepEqual(parseAuxSttOption({ stt: { aux: { vendor: "  ", language: "" } } }), {});
});

test("parseOutputSttOption / parseAuxSttOption share one normaliser but read different blocks", async () => {
  const { parseOutputSttOption } = await import("../lib/aux-stt.js");
  const options = { stt: { aux: { vendor: "assemblyai" } }, tts: { output: { vendor: "deepgram" } } };
  assert.deepEqual(parseAuxSttOption(options), { vendor: "assemblyai" });
  assert.deepEqual(parseOutputSttOption(options), { vendor: "deepgram" });
  assert.equal(parseOutputSttOption({ stt: { aux: {} } }), null);
  assert.equal(parseAuxSttOption({ tts: { output: {} } }), null);
});

test("auxSttAgent: aux block stands in for stt; language inherits stt then tts; nested aux dropped", () => {
  const agent = {
    id: "a",
    options: {
      stt: { vendor: "deepgram", language: "en-US", aux: { vendor: "assemblyai" } },
      tts: { vendor: "cartesia", language: "fr-FR", voice: "v" },
    },
  } as any;
  const a = auxSttAgent(agent, { vendor: "assemblyai" });
  assert.deepEqual(a.options.stt, { vendor: "assemblyai", language: "en-US" });
  // Untouched elsewhere.
  assert.deepEqual(a.options.tts, agent.options.tts);
  assert.equal(agent.options.stt.aux.vendor, "assemblyai"); // input not mutated

  // No stt.language → tts.language; explicit aux language wins over both.
  const b = auxSttAgent({ id: "b", options: { tts: { language: "de-DE" } } } as any, {});
  assert.deepEqual(b.options.stt, { language: "de-DE" });
  const c = auxSttAgent(agent, { vendor: "cartesia", language: "es" });
  assert.deepEqual(c.options.stt, { vendor: "cartesia", language: "es" });
  // Nothing declared anywhere → empty block (platform defaults).
  assert.deepEqual(auxSttAgent({ id: "d" } as any, {}).options.stt, {});
});

test("resolveAuxSttVendor: canonical {vendor, detail} via the pipeline STT resolution", () => {
  const agent = { id: "a", options: {} } as any;
  assert.deepEqual(resolveAuxSttVendor(agent, {}), { vendor: "deepgram", detail: "deepgram/nova-3" });
  assert.deepEqual(resolveAuxSttVendor(agent, { vendor: "assemblyai" }), {
    vendor: "assemblyai",
    detail: "assemblyai/universal-streaming",
  });
  assert.deepEqual(resolveAuxSttVendor(agent, { vendor: "cartesia" }), {
    vendor: "cartesia",
    detail: "cartesia/ink-whisper",
  });
  // A scoped vendor string keeps its model; the :lang suffix is not part of detail.
  assert.deepEqual(resolveAuxSttVendor(agent, { vendor: "deepgram/nova-2:en" }), {
    vendor: "deepgram",
    detail: "deepgram/nova-2",
  });
});

// ---- arm/pump loop with fakes ---------------------------------------------

function fakeRoom() {
  const handlers = new Map<any, (...a: any[]) => void>();
  return {
    on(evt: any, cb: (...a: any[]) => void) {
      handlers.set(evt, cb);
    },
    off(evt: any) {
      handlers.delete(evt);
    },
    emit(evt: any, ...args: any[]) {
      handlers.get(evt)?.(...args);
    },
    handlerCount: () => handlers.size,
  } as any;
}

/** Minimal stand-in for stt.SpeechStream: emits a FINAL after N pushed frames. */
class FakeSpeechStream {
  pushed: any[] = [];
  flushes = 0;
  flush() {
    this.flushes += 1;
  }
  private queue: any[] = [];
  private waiters: Array<(r: IteratorResult<any>) => void> = [];
  private ended = false;
  constructor(private readonly finalAfterFrames: number, private readonly text: string) {}
  pushFrame(frame: any) {
    if (this.ended) throw new Error("input ended");
    this.pushed.push(frame);
    if (this.pushed.length === this.finalAfterFrames) {
      this.put({ type: stt.SpeechEventType.INTERIM_TRANSCRIPT, alternatives: [{ text: "hel" }] });
      this.put({ type: stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives: [{ text: this.text }] });
      this.put({ type: stt.SpeechEventType.END_OF_SPEECH });
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

/** Fake stt.STT: an emitter (metrics_collected / error) around one stream. */
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

/** `n` 20 ms frames at 16 kHz (320 samples each). */
async function* audioFrames(n: number) {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setImmediate(r));
    yield { sampleRate: 16000, samplesPerChannel: 320, channels: 1 } as any;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test("armAuxStt: pumps the caller track, logs finals, meters the engine's own audio report + characters", async () => {
  const room = fakeRoom();
  const stream = new FakeSpeechStream(3, "  hello there ");
  const closed = { n: 0 };
  const transcripts: Array<{ text: string; at: Date }> = [];
  const usage: Record<string, number> = { milliseconds: 0, characters: 0 };
  let cancelled = 0;
  const source = Object.assign(audioFrames(5), { cancel: async () => void cancelled++ });
  const engine = fakeStt(stream, closed);

  const handle = armAuxStt({
    room,
    roomName: "r",
    callerIdentity: "caller",
    agent: { id: "a", options: {} } as any,
    config: {},
    onTranscript: (text, at) => transcripts.push({ text, at }),
    onUsage: (unit, q) => (usage[unit] += q),
    deps: {
      buildStt: () => engine,
      resolveTrack: async () => ({ sid: "track" }) as any,
      openAudioStream: () => source,
    },
  });
  assert.equal(room.handlerCount(), 2, "listens for caller leave + room disconnect");

  await settle();
  assert.deepEqual(
    transcripts.map((t) => t.text),
    ["hello there"],
    "only FINAL events are logged, trimmed",
  );
  assert.ok(transcripts[0].at instanceof Date);
  assert.equal(stream.pushed.length, 5, "every frame reached the engine");
  assert.equal(usage.characters, "hello there".length);
  assert.equal(handle.usage.characters, "hello there".length);
  // 5 × 20 ms were pumped (diagnostic), but the METER is what the engine reports.
  assert.equal(Math.round(handle.usage.streamedMilliseconds), 100);
  assert.equal(usage.milliseconds, 0, "nothing metered until the engine reports");
  engine.emit("metrics_collected", { type: "stt_metrics", audioDurationMs: 4800 });
  engine.emit("metrics_collected", { type: "stt_metrics", audioDurationMs: 0 }); // ignored
  assert.equal(usage.milliseconds, 4800);
  assert.equal(handle.usage.milliseconds, 4800);
  await handle.dispose();
  assert.equal(stream.flushes, 1, "dispose asks the engine to report its last interval");
  assert.equal(usage.milliseconds, 4800, "streamed audio is never billed on its own");
  assert.equal(closed.n, 1, "engine closed on dispose");
  assert.equal(room.handlerCount(), 0, "room listeners removed");
  // Idempotent.
  await handle.dispose();
  assert.equal(closed.n, 1);
  assert.equal(stream.flushes, 1);
});

test("armAuxStt: an engine that accepts nothing (e.g. rejected credentials) meters nothing", async () => {
  const room = fakeRoom();
  const stream = new FakeSpeechStream(99, "never");
  const closed = { n: 0 };
  const usage: Record<string, number> = { milliseconds: 0, characters: 0 };
  const engine = fakeStt(stream, closed);
  const handle = armAuxStt({
    room,
    roomName: "r",
    callerIdentity: "caller",
    agent: { id: "a", options: {} } as any,
    config: {},
    onTranscript: () => assert.fail("no transcript expected"),
    onUsage: (unit, q) => (usage[unit] += q),
    deps: {
      buildStt: () => engine,
      resolveTrack: async () => ({}) as any,
      openAudioStream: () => audioFrames(10),
    },
  });
  await settle();
  // The SDK reports a failing connection as recoverable error events while it retries.
  engine.emit("error", { type: "stt_error", label: "deepgram.STT", recoverable: true, error: new Error("401") });
  assert.equal(closed.n, 0, "a recoverable error keeps the stream up");
  await handle.dispose();
  assert.equal(Math.round(handle.usage.streamedMilliseconds), 200, "audio was pumped");
  assert.equal(usage.milliseconds, 0, "none of it is metered");
  assert.equal(handle.usage.milliseconds, 0);
});

test("armAuxStt: a non-recoverable engine error stops the auxiliary transcription", async () => {
  const room = fakeRoom();
  const stream = new FakeSpeechStream(99, "never");
  const closed = { n: 0 };
  const engine = fakeStt(stream, closed);
  async function* endless() {
    for (;;) {
      await new Promise((r) => setTimeout(r, 5));
      yield { sampleRate: 16000, samplesPerChannel: 160, channels: 1 } as any;
    }
  }
  armAuxStt({
    room,
    roomName: "r",
    callerIdentity: "caller",
    agent: { id: "a", options: {} } as any,
    config: {},
    onTranscript: () => {},
    onUsage: () => {},
    deps: {
      buildStt: () => engine,
      resolveTrack: async () => ({}) as any,
      openAudioStream: () => Object.assign(endless(), { cancel: async () => {} }),
    },
  });
  await settle();
  engine.emit("error", { type: "stt_error", label: "deepgram.STT", recoverable: false, error: new Error("gave up") });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(closed.n, 1, "engine closed");
  const pushedAtStop = stream.pushed.length;
  await settle();
  assert.equal(stream.pushed.length, pushedAtStop, "pump stopped");
  assert.equal(room.handlerCount(), 0);
});

test("armAuxStt: self-disposes when the caller leaves (not on another participant)", async () => {
  const room = fakeRoom();
  const stream = new FakeSpeechStream(99, "never");
  const closed = { n: 0 };
  const usage: Record<string, number> = { milliseconds: 0, characters: 0 };
  // A source that never ends on its own.
  async function* endless() {
    for (;;) {
      await new Promise((r) => setTimeout(r, 5));
      yield { sampleRate: 16000, samplesPerChannel: 160, channels: 1 } as any;
    }
  }
  armAuxStt({
    room,
    roomName: "r",
    callerIdentity: "caller",
    agent: { id: "a", options: {} } as any,
    config: {},
    onTranscript: () => assert.fail("no transcript expected"),
    onUsage: (unit, q) => (usage[unit] += q),
    deps: {
      buildStt: () => fakeStt(stream, closed),
      resolveTrack: async () => ({}) as any,
      openAudioStream: () => Object.assign(endless(), { cancel: async () => {} }),
    },
  });
  await settle();
  const { RoomEvent } = await import("@livekit/rtc-node");
  room.emit(RoomEvent.ParticipantDisconnected, { identity: "someone-else" });
  assert.equal(closed.n, 0, "another participant leaving does not stop it");
  room.emit(RoomEvent.ParticipantDisconnected, { info: { identity: "caller" } });
  await new Promise((r) => setTimeout(r, 400)); // dispose gives the engine a grace period to report
  assert.equal(closed.n, 1, "caller leaving disposes");
  assert.equal(usage.milliseconds, 0, "no engine report, nothing metered");
  const pushedAtDispose = stream.pushed.length;
  await settle();
  assert.equal(stream.pushed.length, pushedAtDispose, "pump stopped");
});

test("armAuxStt: an engine that fails to build is contained; dispose still safe", async () => {
  const room = fakeRoom();
  const transcripts: string[] = [];
  const handle = armAuxStt({
    room,
    roomName: "r",
    callerIdentity: "caller",
    agent: { id: "a", options: {} } as any,
    config: { vendor: "nope" },
    onTranscript: (t) => transcripts.push(t),
    onUsage: () => assert.fail("no usage expected"),
    deps: {
      buildStt: () => {
        throw new Error("no such vendor");
      },
      resolveTrack: async () => ({}) as any,
      openAudioStream: () => audioFrames(1),
    },
  });
  await settle();
  assert.deepEqual(transcripts, []);
  await handle.dispose();
  assert.deepEqual(handle.usage, { milliseconds: 0, characters: 0, streamedMilliseconds: 0 });
});

test("armAuxStt: disposing before the track resolves never starts the engine", async () => {
  const room = fakeRoom();
  let built = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const handle = armAuxStt({
    room,
    roomName: "r",
    callerIdentity: "caller",
    agent: { id: "a", options: {} } as any,
    config: {},
    onTranscript: () => {},
    onUsage: () => {},
    deps: {
      buildStt: () => {
        built++;
        return fakeStt(new FakeSpeechStream(99, ""), { n: 0 });
      },
      resolveTrack: async () => {
        await gate;
        return {} as any;
      },
      openAudioStream: () => audioFrames(1),
    },
  });
  await handle.dispose();
  release();
  await settle();
  assert.equal(built, 0);
});
