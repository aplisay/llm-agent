import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";

// `formatted` and the Deepgram options: what each engine is sent, and how the side blocks carry them.
// See docs/stt-formatting.md. Mirrors agents/pipecat/tests/test_stt_formatting.py.
// run: node --import tsx --test test/stt-formatting.test.ts

initializeLogger({ pretty: false, level: "fatal" });
process.env.LIVEKIT_API_KEY ??= "test-key";
process.env.LIVEKIT_API_SECRET ??= "test-secret";

const {
  deepgramFormatting,
  deepgramPluginFormatting,
  inferenceSttModelOptions,
  pickSttFormatting,
  sideEngineTiming,
} = await import("../lib/stt-formatting.js");
const { auxSttAgent, frameHasSpeech, outputSttAgent, parseAuxSttOption, parseOutputSttOption, startSideSttEngine } =
  await import("../lib/aux-stt.js");
const { buildPipelineStt } = await import("../lib/pipeline-routing.js");

const inferenceRoute = (stage: string) => ({ stage, vendor: "x", route: "inference" as const, fallback: false });
const agentWith = (stt: Record<string, unknown>, tts?: Record<string, unknown>) =>
  ({ prompt: "p", options: { stt, ...(tts ? { tts } : {}) } }) as any;

test("formatted sends smart_format, punctuate and no_delay to Deepgram, and never numerals", () => {
  assert.deepEqual(deepgramFormatting({ formatted: true }, false), {
    smart_format: true,
    punctuate: true,
    no_delay: true,
  });
});

test("on the caller-side aux engine formatted also waits 1500 ms for a pause", () => {
  assert.deepEqual(deepgramFormatting({ formatted: true }, true), {
    smart_format: true,
    punctuate: true,
    no_delay: true,
    endpointing: 1500,
  });
});

test("unset or false formatted sends nothing", () => {
  assert.deepEqual(deepgramFormatting({}, false), {});
  assert.deepEqual(deepgramFormatting({ formatted: false }, true), {});
  assert.deepEqual(deepgramFormatting(undefined, true), {});
});

test("a Deepgram option set in the block wins over the bundle", () => {
  assert.deepEqual(
    deepgramFormatting({ formatted: true, smart_format: false, endpointing: false, numerals: true }, true),
    { smart_format: false, punctuate: true, no_delay: true, endpointing: false, numerals: true },
  );
  assert.deepEqual(deepgramFormatting({ no_delay: false, endpointing: 800 }, false), { no_delay: false, endpointing: 800 });
});

test("wrong types are dropped, not sent", () => {
  assert.deepEqual(pickSttFormatting({ formatted: "yes", smart_format: 1, endpointing: true, numerals: false }), {
    numerals: false,
  });
  assert.deepEqual(pickSttFormatting({ endpointing: -5 }), {});
});

test("the Deepgram plugin gets camelCase options, and Flux gets none", () => {
  assert.deepEqual(deepgramPluginFormatting("nova-3", { formatted: true }, true), {
    smartFormat: true,
    punctuate: true,
    noDelay: true,
    endpointing: 1500,
  });
  assert.deepEqual(deepgramPluginFormatting("nova-3", {}, true), {});
  assert.deepEqual(deepgramPluginFormatting("flux-general-en", { formatted: true }, true), {});
});

test("Inference modelOptions per engine", () => {
  const side = { formatted: true };
  assert.deepEqual(inferenceSttModelOptions("deepgram/nova-3:en", side, true), {
    smart_format: true,
    punctuate: true,
    no_delay: true,
    endpointing: 1500,
  });
  assert.deepEqual(inferenceSttModelOptions("deepgram/flux-general:en", side, true), {});
  assert.deepEqual(inferenceSttModelOptions("assemblyai/universal-streaming:en", side, false), { format_turns: true });
  // Universal-3.x Pro always format.
  assert.deepEqual(inferenceSttModelOptions("assemblyai/universal-3-5-pro:en", side, false), {});
  assert.deepEqual(inferenceSttModelOptions("cartesia/ink-whisper:en", side, false), {});
  assert.deepEqual(inferenceSttModelOptions("cartesia/ink-whisper:en", side, true), { max_silence_duration_secs: 1.5 });
  assert.deepEqual(inferenceSttModelOptions("assemblyai/universal-streaming:en", {}, true), {});
  // Deepgram options never reach another engine.
  assert.deepEqual(inferenceSttModelOptions("assemblyai/universal-streaming:en", { smart_format: true }, true), {});
});

test("the side blocks carry the fields, and do not take them from options.stt", () => {
  const options = {
    stt: { formatted: true, endpointing: 300, aux: { vendor: "deepgram", formatted: true } },
    tts: { output: { no_delay: false } },
  };
  const aux = parseAuxSttOption(options)!;
  assert.deepEqual(aux, { vendor: "deepgram", formatted: true });
  const output = parseOutputSttOption(options)!;
  assert.deepEqual(output, { no_delay: false });

  const agent = { prompt: "p", options } as any;
  assert.deepEqual(auxSttAgent(agent, aux).options!.stt, { vendor: "deepgram", formatted: true });
  assert.deepEqual(outputSttAgent(agent, output).options!.stt, { no_delay: false });
});

test("an Inference build sends the options as modelOptions", () => {
  const side = buildPipelineStt(agentWith({ vendor: "assemblyai", formatted: true }), inferenceRoute("aux-stt"), {
    longPause: true,
  }) as any;
  assert.deepEqual(side.opts.modelOptions, { format_turns: true });
  assert.equal(side.opts.model, "assemblyai/universal-streaming");

  const primary = buildPipelineStt(agentWith({ formatted: true, language: "en-GB" }), inferenceRoute("stt")) as any;
  assert.deepEqual(primary.opts.modelOptions, { smart_format: true, punctuate: true, no_delay: true });
  assert.equal(primary.opts.language, "en");

  const plain = buildPipelineStt(agentWith({}), inferenceRoute("stt")) as any;
  assert.deepEqual(plain.opts.modelOptions, {});
});

test("sideEngineTiming: long-pause settings only where a long pause is asked for", () => {
  assert.deepEqual(sideEngineTiming("deepgram.STT", { formatted: true }, true), {
    sendAllAudio: true,
    finalizeAfterIdleMs: 2500,
    drainMs: 2000,
  });
  assert.deepEqual(sideEngineTiming("inference.STT", { formatted: true }, true), { sendAllAudio: false, drainMs: 2000 });
  // The output engine (no long pause) and unformatted blocks keep the default behaviour.
  assert.deepEqual(sideEngineTiming("deepgram.STT", { formatted: true }, false), { sendAllAudio: false });
  assert.deepEqual(sideEngineTiming("deepgram.STT", {}, true), { sendAllAudio: false });
  assert.deepEqual(sideEngineTiming("deepgram.STT", { endpointing: 800 }, true), { sendAllAudio: false });
  // An explicit long endpointing gets the same treatment on any side engine.
  assert.deepEqual(sideEngineTiming("deepgram.STT", { endpointing: 2000 }, false), {
    sendAllAudio: true,
    finalizeAfterIdleMs: 3000,
    drainMs: 2000,
  });
});

test("frameHasSpeech uses the plugin's energy threshold", () => {
  const frame = (v: number) => ({ data: new Int16Array(320).fill(v), sampleRate: 16000, samplesPerChannel: 320 }) as any;
  assert.equal(frameHasSpeech(frame(0)), false);
  assert.equal(frameHasSpeech(frame(100)), false); // about 0.003 of full scale
  assert.equal(frameHasSpeech(frame(1000)), true);
});

function fakeStream() {
  const state = { flushes: 0, ended: false, events: [] as any[], waiters: [] as Array<(r: IteratorResult<any>) => void> };
  const put = (ev: any) => {
    const w = state.waiters.shift();
    if (w) w({ value: ev, done: false });
    else state.events.push(ev);
  };
  const finish = () => {
    state.ended = true;
    for (const w of state.waiters.splice(0)) w({ value: undefined, done: true });
  };
  const stream = {
    pushFrame() {},
    flush() {
      state.flushes += 1;
    },
    endInput() {
      // A real engine finalizes held words when its input ends, then closes.
      put({ type: 2, alternatives: [{ text: "the last words" }] });
      setTimeout(finish, 20);
    },
    close() {
      finish();
    },
    next(): Promise<IteratorResult<any>> {
      if (state.events.length) return Promise.resolve({ value: state.events.shift(), done: false });
      if (state.ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((r) => state.waiters.push(r));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { state, stream };
}

const loud = () => ({ data: new Int16Array(320).fill(2000), sampleRate: 16000, samplesPerChannel: 320 }) as any;
const quiet = () => ({ data: new Int16Array(320), sampleRate: 16000, samplesPerChannel: 320 }) as any;
const engineFor = (stream: unknown, label = "deepgram.STT") =>
  ({ label, stream: () => stream, on() {}, off() {}, close: async () => {} }) as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the idle backstop flushes only when frames stop arriving after speech", async () => {
  const { state, stream } = fakeStream();
  const engine = startSideSttEngine({
    label: "auxStt",
    roomName: "r",
    subject: "s",
    stt: engineFor(stream),
    onTranscript: () => {},
    onUsage: () => {},
    timing: { finalizeAfterIdleMs: 60 },
  });
  engine.push(loud());
  for (let i = 0; i < 6; i++) {
    await sleep(20);
    engine.push(quiet()); // silence still arriving: no flush
  }
  assert.equal(state.flushes, 0);
  await sleep(100); // frames stopped
  assert.equal(state.flushes, 1);
  await sleep(100);
  assert.equal(state.flushes, 1, "no second flush without new speech");
  await engine.dispose();
});

test("with drainMs, a dispose waits for the final the engine sends when its input ends", async () => {
  const got: string[] = [];
  const { stream } = fakeStream();
  const engine = startSideSttEngine({
    label: "auxStt",
    roomName: "r",
    subject: "s",
    stt: engineFor(stream),
    onTranscript: (text) => got.push(text),
    onUsage: () => {},
    timing: { drainMs: 500 },
  });
  await engine.dispose();
  assert.deepEqual(got, ["the last words"]);
});

test("without drainMs, a dispose keeps the old behaviour and takes no final", async () => {
  const got: string[] = [];
  const { stream } = fakeStream();
  const engine = startSideSttEngine({
    label: "auxStt",
    roomName: "r",
    subject: "s",
    stt: engineFor(stream),
    onTranscript: (text) => got.push(text),
    onUsage: () => {},
  });
  await engine.dispose();
  assert.deepEqual(got, []);
});
