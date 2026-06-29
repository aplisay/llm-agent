import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUsageVendors } from "../lib/usage-vendors.js";

// Unit tests for the canonical billing-vendor resolver (R3). Pure / SDK-free:
// run with `node --import tsx --test test/usage-vendors.test.ts`.

const agent = (opts: unknown) => ({ options: opts }) as never;

test("LLM vendor + detail from livekit:<plugin>/<model>", () => {
  const v = resolveUsageVendors(agent({}), "livekit:openai/gpt-4o");
  assert.equal(v.llm.vendor, "openai");
  assert.equal(v.llm.detail, "openai/gpt-4o");
});

test("LLM realtime model keeps its plugin vendor", () => {
  const v = resolveUsageVendors(agent({}), "livekit:google/gemini-2.0-flash-realtime");
  assert.equal(v.llm.vendor, "google");
  assert.equal(v.llm.detail, "google/gemini-2.0-flash-realtime");
});

test("TTS vendor from configured options (cartesia), not the metric label", () => {
  const v = resolveUsageVendors(
    agent({ tts: { vendor: "cartesia", voice: "71a7ad14" } }),
    "livekit:openai/gpt-4o",
  );
  assert.equal(v.tts.vendor, "cartesia");
  assert.ok(v.tts.detail?.startsWith("cartesia/"));
});

test("TTS elevenlabs", () => {
  const v = resolveUsageVendors(
    agent({ tts: { vendor: "elevenlabs", voice: "Rachel" } }),
    "livekit:openai/gpt-4o",
  );
  assert.equal(v.tts.vendor, "elevenlabs");
  assert.ok(v.tts.detail?.startsWith("elevenlabs/"));
});

test("STT defaults to deepgram", () => {
  const v = resolveUsageVendors(agent({}), "livekit:openai/gpt-4o");
  assert.equal(v.stt.vendor, "deepgram");
  assert.ok(v.stt.detail?.startsWith("deepgram/"));
});

test("STT explicit vendor (assemblyai)", () => {
  const v = resolveUsageVendors(
    agent({ stt: { vendor: "assemblyai" } }),
    "livekit:openai/gpt-4o",
  );
  assert.equal(v.stt.vendor, "assemblyai");
});

test("unparseable model name -> empty llm vendor (graceful, falls back to label)", () => {
  const v = resolveUsageVendors(agent({}), "weird-model");
  assert.equal(v.llm.vendor, undefined);
  assert.equal(v.llm.detail, undefined);
});
