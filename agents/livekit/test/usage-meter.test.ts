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

test("a metrics object reported more than once is metered once; an equal one is metered again", async () => {
  const saved: any[] = [];
  const meter = makeUsageMeter({
    getCall: () => ({ id: "call-1", organisationId: "o1", userId: "u1", agentId: "a1" }),
    usageVendors: vendors,
    saveUsageFn: async (records) => {
      saved.push(...(records as any[]));
    },
  });
  const s = fakeSession();
  meter.wire(s);

  // After an in-place handover the session reports each event once per agent activity.
  // See test/handover-metering.test.ts.
  const reply = { type: "tts_metrics", label: "cartesia.TTS", charactersCount: 42, audioDurationMs: 1500 };
  s.emit(voice.AgentSessionEventTypes.MetricsCollected, { metrics: reply });
  s.emit(voice.AgentSessionEventTypes.MetricsCollected, { metrics: reply });
  // The same text spoken again is a second reply.
  s.emit(voice.AgentSessionEventTypes.MetricsCollected, { metrics: { ...reply } });

  await meter.flush(true);
  const row = (unit: string) => saved.find((r) => r.technology === "tts" && r.unit === unit);
  assert.equal(row("characters").quantity, 84);
  assert.equal(row("milliseconds").quantity, 3000);
});

async function llmRows(voiceMode: "pipeline" | "realtime", ...metrics: any[]) {
  const saved: any[] = [];
  const meter = makeUsageMeter({
    getCall: () => ({ id: "call-1", organisationId: "o1", userId: "u1", agentId: "a1" }),
    usageVendors: vendors,
    voiceMode,
    saveUsageFn: async (records) => {
      saved.push(...(records as any[]));
    },
  });
  const s = fakeSession();
  meter.wire(s);
  for (const m of metrics) s.emit(voice.AgentSessionEventTypes.MetricsCollected, { metrics: m });
  await meter.flush(true);
  return Object.fromEntries(saved.filter((r) => r.technology === "llm").map((r) => [r.unit, r.quantity]));
}

// Token counts below are from live requests on 2026-09-16 with a 4.6k-token prompt sent twice.
test("llm_metrics input_tokens excludes the cached tokens the plugins count inside promptTokens", async () => {
  const openai = { type: "llm_metrics", label: "openai.LLM", promptTokens: 4638, promptCachedTokens: 4608, completionTokens: 1 };
  assert.deepEqual(await llmRows("pipeline", openai), {
    input_tokens: 30,
    output_tokens: 1,
    cache_read_tokens: 4608,
  });

  const gemini = { type: "llm_metrics", label: "google.LLM", promptTokens: 5328, promptCachedTokens: 5094, completionTokens: 1 };
  const cold = { ...gemini, promptCachedTokens: 0 };
  assert.deepEqual(await llmRows("pipeline", cold, gemini), {
    input_tokens: 5328 + 234,
    output_tokens: 2,
    cache_read_tokens: 5094,
  });
});

test("realtime_model_metrics input_tokens excludes the cached tokens OpenAI Realtime counts inside inputTokens", async () => {
  const response = {
    type: "realtime_model_metrics",
    label: "openai_realtime",
    inputTokens: 4648,
    outputTokens: 4,
    inputTokenDetails: { audioTokens: 0, textTokens: 4648, imageTokens: 0, cachedTokens: 4608 },
  };
  assert.deepEqual(await llmRows("realtime", response), {
    input_tokens: 40,
    output_tokens: 4,
    cache_read_tokens: 4608,
  });
});

test("realtime voiceMode suppresses stt/tts component rows but keeps llm", async () => {
  const saved: any[] = [];
  const meter = makeUsageMeter({
    getCall: () => ({ id: "consult-rt", organisationId: "o1", userId: "u1", agentId: "a1" }),
    usageVendors: vendors,
    voiceMode: "realtime",
    saveUsageFn: async (records) => {
      saved.push(...(records as any[]));
    },
  });
  const s = fakeSession();
  meter.wire(s);

  // Realtime models bundle STT/TTS; transcription events must not create separate STT charges. See PR #126.
  s.emit(voice.AgentSessionEventTypes.MetricsCollected, {
    metrics: { type: "llm_metrics", label: "inference.LLM", promptTokens: 100, completionTokens: 20 },
  });
  s.emit(voice.AgentSessionEventTypes.MetricsCollected, {
    metrics: { type: "tts_metrics", label: "inference.TTS", charactersCount: 42, audioDurationMs: 1500 },
  });
  s.emit(voice.AgentSessionEventTypes.UserInputTranscribed, { isFinal: true, transcript: "hello there" });

  await meter.flush(true);

  assert.ok(saved.every((r) => r.technology !== "stt"), "no stt rows for realtime");
  assert.ok(saved.every((r) => r.technology !== "tts"), "no tts rows for realtime");
  assert.equal(saved.find((r) => r.technology === "llm" && r.unit === "input_tokens")?.quantity, 100);
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
