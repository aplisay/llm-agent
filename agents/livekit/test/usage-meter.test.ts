import { test } from "node:test";
import assert from "node:assert/strict";
import { voice } from "@livekit/agents";
import { makeUsageMeter } from "../lib/usage-meter.js";

// Drives makeUsageMeter with a fake session + injected save fn (no network).
// run: node --import tsx --test test/usage-meter.test.ts

function fakeSession() {
  const handlers = new Map<string, (ev: any) => void>();
  return {
    on(evt: string, cb: (ev: any) => void) {
      handlers.set(evt, cb);
    },
    emit(evt: string, ev: any) {
      handlers.get(evt)?.(ev);
    },
  } as any;
}

const vendors = {
  llm: { vendor: "openai", detail: "openai/gpt-4o" },
  tts: { vendor: "cartesia", detail: "cartesia/sonic-3" },
  stt: { vendor: "deepgram", detail: "deepgram/nova-3" },
} as any;

test("accumulates llm/tts/stt and flushes vendor-correct per-call records", async () => {
  const saved: any[] = [];
  const meter = makeUsageMeter({
    getCall: () => ({ id: "consult-1", organisationId: "o1", userId: "u1", agentId: "a1" }),
    usageVendors: vendors,
    saveUsageFn: async (records) => {
      saved.push(...(records as any[]));
    },
  });
  const s = fakeSession();
  meter.wire(s);

  // Vendor-blind labels ('inference.*') must NOT leak into provider.
  s.emit(voice.AgentSessionEventTypes.MetricsCollected, {
    metrics: { type: "llm_metrics", label: "inference.LLM", promptTokens: 100, completionTokens: 20, promptCachedTokens: 0 },
  });
  s.emit(voice.AgentSessionEventTypes.MetricsCollected, {
    metrics: { type: "tts_metrics", label: "inference.TTS", charactersCount: 42, audioDurationMs: 1500 },
  });
  s.emit(voice.AgentSessionEventTypes.UserInputTranscribed, { isFinal: true, transcript: "hello there" });

  await meter.flush(true);

  const row = (tech: string, unit: string) => saved.find((r) => r.technology === tech && r.unit === unit);
  assert.equal(row("llm", "input_tokens").quantity, 100);
  assert.equal(row("llm", "input_tokens").provider, "openai");
  assert.equal(row("llm", "input_tokens").callId, "consult-1");
  assert.equal(row("tts", "characters").quantity, 42);
  assert.equal(row("tts", "characters").provider, "cartesia");
  assert.equal(row("tts", "milliseconds").quantity, 1500);
  assert.equal(row("stt", "characters").quantity, "hello there".length);
  assert.equal(row("stt", "characters").provider, "deepgram");
  assert.ok(saved.every((r) => r.mode === "set" && r.finalised === true));
});

test("flush is a no-op when no call is resolved", async () => {
  let called = false;
  const meter = makeUsageMeter({
    getCall: () => null,
    usageVendors: vendors,
    saveUsageFn: async () => {
      called = true;
    },
  });
  const s = fakeSession();
  meter.wire(s);
  s.emit(voice.AgentSessionEventTypes.MetricsCollected, {
    metrics: { type: "llm_metrics", label: "x", promptTokens: 5 },
  });
  await meter.flush(true);
  assert.equal(called, false);
});
