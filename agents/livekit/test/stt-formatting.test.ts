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
  selfFinalizeAfterMs,
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

test("only the Deepgram plugin with a pause of 1000 ms or more finalizes itself", () => {
  assert.equal(selfFinalizeAfterMs("deepgram.STT", { formatted: true }, true), 1500);
  assert.equal(selfFinalizeAfterMs("deepgram.STT", { formatted: true }, false), undefined);
  assert.equal(selfFinalizeAfterMs("deepgram.STT", { endpointing: 800 }, true), undefined);
  assert.equal(selfFinalizeAfterMs("deepgram.STT", { endpointing: 2000 }, false), 2000);
  assert.equal(selfFinalizeAfterMs("inference.STT", { formatted: true }, true), undefined);
});

test("frameHasSpeech uses the plugin's energy threshold", () => {
  const frame = (v: number) => ({ data: new Int16Array(320).fill(v), sampleRate: 16000, samplesPerChannel: 320 }) as any;
  assert.equal(frameHasSpeech(frame(0)), false);
  assert.equal(frameHasSpeech(frame(100)), false); // about 0.003 of full scale
  assert.equal(frameHasSpeech(frame(1000)), true);
});

test("a side engine flushes itself once speech has been quiet for the pause, and only once", async () => {
  let flushes = 0;
  const stream = {
    pushFrame() {},
    flush() {
      flushes += 1;
    },
    endInput() {},
    close() {},
    async *[Symbol.asyncIterator]() {},
  };
  const engineStt = { label: "deepgram.STT", stream: () => stream, on() {}, off() {}, close: async () => {} } as any;
  const engine = startSideSttEngine({
    label: "auxStt",
    roomName: "r",
    subject: "s",
    stt: engineStt,
    onTranscript: () => {},
    onUsage: () => {},
    finalizeAfterSilenceMs: 60,
  });
  const loud = { data: new Int16Array(320).fill(2000), sampleRate: 16000, samplesPerChannel: 320 } as any;
  const quiet = { data: new Int16Array(320), sampleRate: 16000, samplesPerChannel: 320 } as any;
  engine.push(loud);
  engine.push(quiet);
  await new Promise((r) => setTimeout(r, 30));
  engine.push(loud); // speech again: the timer starts over
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(flushes, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(flushes, 1);
  engine.push(quiet);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(flushes, 1, "silence alone does not flush again");
  await engine.dispose();
});
