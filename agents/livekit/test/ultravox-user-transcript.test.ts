import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTranscriptFrame } from "../plugins/ultravox/src/realtime/realtime_model.js";

// Covers user-transcript accumulation in the Ultravox realtime plugin. Before this,
// the user branch of #handleTranscript read `event.text` only, so a turn Ultravox
// delivered as `delta` fragments with no `text` on the final frame was dropped
// outright — no ConversationItemAdded, so the turn reached neither the transcript nor
// the agent's own history. The agent branch has buffered deltas from the start.
// run: npx tsx --test test/ultravox-user-transcript.test.ts

/** Replay a turn's frames the way #handleTranscript does, returning the final text. */
const replay = (frames: Array<{ text?: string; delta?: string }>) =>
  frames.reduce((buffer, frame) => foldTranscriptFrame(buffer, frame), "");

test("text-only frames: the final snapshot wins (existing Ultravox behaviour)", () => {
  assert.equal(
    replay([{ text: "Yes, I will" }, { text: "Yes, I will take the call." }]),
    "Yes, I will take the call.",
  );
});

test("delta-only turn is accumulated rather than dropped", () => {
  assert.equal(
    replay([{ delta: "Yes," }, { delta: " I will take" }, { delta: " the call." }]),
    "Yes, I will take the call.",
  );
});

test("final frame carrying only a delta still completes the turn", () => {
  // The reported failure shape: interim deltas, then a final with no `text`.
  assert.equal(replay([{ delta: "Yes, I will take" }, { delta: " the call." }]), "Yes, I will take the call.");
});

test("a text snapshot supersedes anything accumulated so far", () => {
  assert.equal(
    replay([{ delta: "Yess I wil" }, { text: "Yes, I will take the call." }]),
    "Yes, I will take the call.",
  );
});

test("frames with neither text nor delta leave the buffer untouched", () => {
  assert.equal(replay([{ delta: "Hello" }, {}, { delta: " there" }]), "Hello there");
});

test("an entirely empty turn stays empty (still reported as skipped)", () => {
  assert.equal(replay([{}]), "");
  assert.equal(replay([{ text: "" }]), "");
  assert.equal(replay([{ delta: "" }]), "");
});

test("empty string text does not clobber an accumulated turn", () => {
  // `text: ""` is falsy, so it must not be treated as an authoritative snapshot.
  assert.equal(replay([{ delta: "Hello there" }, { text: "" }]), "Hello there");
});

// --- turn boundaries -------------------------------------------------------
// #handleTranscript resets the buffer when `ordinal` changes, so a turn abandoned
// without a final frame (barge-in) cannot prefix the next one. Replayed here the
// same way the handler sequences it.

const replayWithOrdinals = (
  frames: Array<{ text?: string; delta?: string; final?: boolean; ordinal?: number }>,
) => {
  let buffer = "";
  let ordinal: number | undefined;
  const emitted: string[] = [];
  for (const frame of frames) {
    if (frame.ordinal !== undefined && frame.ordinal !== ordinal) {
      buffer = "";
      ordinal = frame.ordinal;
    }
    buffer = foldTranscriptFrame(buffer, frame);
    if (frame.final) {
      emitted.push(buffer);
      buffer = "";
    }
  }
  return { emitted, buffer };
};

test("an abandoned turn does not prefix the next one", () => {
  const { emitted } = replayWithOrdinals([
    // Turn 1: user starts speaking, gets cut off — no final frame ever arrives.
    { ordinal: 1, delta: "Sorry can you" },
    // Turn 2: a complete delta-only turn.
    { ordinal: 3, delta: "Yes, I will take" },
    { ordinal: 3, delta: " the call.", final: true },
  ]);
  assert.deepEqual(emitted, ["Yes, I will take the call."]);
});

test("consecutive complete turns are emitted independently", () => {
  const { emitted, buffer } = replayWithOrdinals([
    { ordinal: 1, delta: "James", final: false },
    { ordinal: 1, text: "James speaking.", final: true },
    { ordinal: 3, delta: "Yes, I will take the call.", final: true },
  ]);
  assert.deepEqual(emitted, ["James speaking.", "Yes, I will take the call."]);
  assert.equal(buffer, "", "buffer is drained after the last final");
});
