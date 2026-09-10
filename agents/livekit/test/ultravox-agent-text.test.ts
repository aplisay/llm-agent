import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTextChunk } from "../plugins/ultravox/src/realtime/realtime_model.js";

// Text-output mode streams the agent's text into the generation exactly once per
// character. The frame shapes are the ones Ultravox was measured to send on
// 2026-09-10: a first `text` snapshot, `delta` frames, a final `text` snapshot;
// a greeting as one final frame; a truncated final after a barge-in.
// run: node --import tsx --test test/ultravox-agent-text.test.ts

/** Replay frames the way #handleAgentTextTranscript does, collecting the chunks written. */
const replay = (frames: Array<{ text?: string | null; delta?: string | null; final?: boolean }>) => {
  let streamed = "";
  const chunks: string[] = [];
  for (const frame of frames) {
    const r = agentTextChunk(streamed, frame);
    streamed = frame.final ? "" : r.streamed;
    if (r.chunk) chunks.push(r.chunk);
  }
  return chunks;
};

test("a streamed turn yields each chunk exactly once", () => {
  assert.deepEqual(
    replay([
      { text: "In", delta: null },
      { text: null, delta: " a" },
      { text: null, delta: " small" },
      { text: "In a small", delta: null, final: true },
    ]),
    ["In", " a", " small"],
  );
});

test("a greeting arriving as one final frame is still spoken", () => {
  assert.deepEqual(replay([{ text: "Hello, this is the greeting.", final: true }]), ["Hello, this is the greeting."]);
});

test("a truncated final after a barge-in adds nothing", () => {
  assert.deepEqual(
    replay([{ text: "Once" }, { delta: " upon" }, { text: "Once", final: true }]),
    ["Once", " upon"],
  );
});

test("a mid-turn snapshot contributes only the new part", () => {
  assert.deepEqual(
    replay([{ text: "The" }, { delta: " cat" }, { text: "The cat sat" }, { text: "The cat sat", final: true }]),
    ["The", " cat", " sat"],
  );
});

test("empty frames contribute nothing", () => {
  assert.deepEqual(replay([{ text: "" }, { delta: "" }, {}]), []);
});
