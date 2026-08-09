import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBridgedTranscribeOption,
  BridgeTranscriptCollector,
  CALLER,
  TARGET,
} from "../lib/bridge-transcription.js";

// Option parser + transcript collector for options.bridgedTransferTranscribe.
// run: node --import tsx --test test/bridge-transcription.test.ts

const makeCall = () =>
  ({
    id: "call-1",
    userId: "user-1",
    organisationId: "org-1",
  }) as any;

test("parseBridgedTranscribeOption: absent/false/disabled give null", () => {
  assert.equal(parseBridgedTranscribeOption(undefined), null);
  assert.equal(parseBridgedTranscribeOption({}), null);
  assert.equal(
    parseBridgedTranscribeOption({ bridgedTransferTranscribe: false }),
    null,
  );
  assert.equal(
    parseBridgedTranscribeOption({
      bridgedTransferTranscribe: { enabled: false, provider: "deepgram" },
    }),
    null,
  );
  // Malformed shapes are off, not errors (lenient like pipecat).
  assert.equal(
    parseBridgedTranscribeOption({ bridgedTransferTranscribe: "yes" }),
    null,
  );
  assert.equal(
    parseBridgedTranscribeOption({ bridgedTransferTranscribe: ["deepgram"] }),
    null,
  );
});

test("parseBridgedTranscribeOption: true and object forms normalise", () => {
  assert.deepEqual(
    parseBridgedTranscribeOption({ bridgedTransferTranscribe: true }),
    { provider: "elevenlabs", language: null },
  );
  assert.deepEqual(
    parseBridgedTranscribeOption({ bridgedTransferTranscribe: {} }),
    { provider: "elevenlabs", language: null },
  );
  assert.deepEqual(
    parseBridgedTranscribeOption({
      bridgedTransferTranscribe: { provider: "deepgram", language: "en-GB" },
    }),
    { provider: "deepgram", language: "en-GB" },
  );
  // enabled: true is the explicit-on idiom.
  assert.deepEqual(
    parseBridgedTranscribeOption({
      bridgedTransferTranscribe: { enabled: true, language: " fr " },
    }),
    { provider: "elevenlabs", language: "fr" },
  );
});

test("collector: entries are speaker-labelled and batched onto the call record", async () => {
  const call = makeCall();
  const collector = new BridgeTranscriptCollector(call, false);
  await collector.add(CALLER, "  hello there  ");
  await collector.add(TARGET, "hi, how can I help");
  await collector.add(CALLER, ""); // empty finals are dropped
  assert.equal(collector.length, 2);

  const batched = (call as any).batchedTransactionLogs;
  assert.equal(batched.length, 2);
  assert.deepEqual(
    batched.map((e: any) => ({
      callId: e.callId,
      type: e.type,
      data: e.data,
      isFinal: e.isFinal,
    })),
    [
      { callId: "call-1", type: "user", data: "hello there", isFinal: true },
      {
        callId: "call-1",
        type: "agent",
        data: "hi, how can I help",
        isFinal: true,
      },
    ],
  );
  assert.equal(batched[0].userId, "user-1");
  assert.equal(batched[0].organisationId, "org-1");
});

test("collector: render merges chronologically across speakers", async () => {
  let clock = 0;
  const collector = new BridgeTranscriptCollector(makeCall(), false, () => clock);
  clock = 30;
  await collector.add(TARGET, "who is calling");
  clock = 10;
  await collector.add(CALLER, "hello");
  clock = 20;
  await collector.add(CALLER, "it's me");
  assert.equal(
    collector.render(),
    "> caller: hello\n> caller: it's me\n> transfer target: who is calling\n",
  );
});

test("collector: empty collector renders empty string", () => {
  const collector = new BridgeTranscriptCollector(makeCall(), false);
  assert.equal(collector.render(), "");
  assert.equal(collector.length, 0);
});
