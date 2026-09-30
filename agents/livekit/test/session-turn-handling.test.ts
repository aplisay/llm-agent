import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";
import { createVoiceModelAndSession } from "../lib/voice-session-factory.js";

// Every factory session keeps agents-js 1.0.46 turn-taking: 1.9 turns on a bundled VAD, an
// audio turn detector, adaptive interruption, preemptive generation, an AEC warm-up and
// false-interruption resume unless told not to (legacyTurnHandlingOptions).
// run: npx tsx --test test/session-turn-handling.test.ts

initializeLogger({ pretty: false, level: "fatal" });

// The plugins only check that a key is present when the model is built.
for (const key of ["OPENAI_API_KEY", "ULTRAVOX_API_KEY", "GOOGLE_API_KEY", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) {
  process.env[key] ??= "test-key";
}

const makeAgent = (options: Record<string, unknown> = {}) =>
  ({ prompt: "You are a test agent.", options }) as any;

const build = (voiceMode: "pipeline" | "realtime", modelName: string, agent = makeAgent(), vad?: any) =>
  createVoiceModelAndSession({ voiceMode, modelName, agent, call: { id: "call-1" } as any, tools: undefined as any, vad })
    .session as any;

function assertLegacyTurnTaking(session: any, label: string) {
  const o = session.sessionOptions;
  assert.equal(o.aecWarmupDuration, null, `${label}: no AEC warm-up`);
  assert.equal(o.turnHandling.preemptiveGeneration.enabled, false, `${label}: no preemptive generation`);
  assert.equal(o.turnHandling.interruption.mode, "vad", `${label}: no adaptive interruption`);
  assert.equal(o.turnHandling.interruption.resumeFalseInterruption, false, `${label}: no resume`);
  assert.equal(o.turnHandling.interruption.discardAudioIfUninterruptible, true, label);
  assert.equal(o.turnHandling.endpointing.minDelay, 500, label);
  assert.equal(o.turnHandling.endpointing.maxDelay, 6000, label);
}

test("realtime sessions get no VAD and no SDK turn detector", () => {
  for (const modelName of [
    "livekit:openai/gpt-realtime",
    "livekit:ultravox/ultravox-v0.7",
    "livekit:google/gemini-2.0-flash-exp",
  ]) {
    const session = build("realtime", modelName);
    assert.equal(session.vad, undefined, modelName);
    assert.equal(session.turnDetection, undefined, modelName);
    assertLegacyTurnTaking(session, modelName);
  }
});

test("a pipeline session turns on STT, or on the prewarmed VAD when there is one", () => {
  const stt = build("pipeline", "livekit:openai/gpt-4o-mini");
  assert.equal(stt.vad, undefined);
  assert.equal(stt.turnDetection, "stt");
  assertLegacyTurnTaking(stt, "pipeline");

  const prewarmed = { label: "silero.VAD" };
  const withVad = build("pipeline", "livekit:openai/gpt-4o-mini", makeAgent(), prewarmed);
  assert.equal(withVad.vad, prewarmed);
  assert.equal(withVad.turnDetection, "vad");
  assertLegacyTurnTaking(withVad, "pipeline with VAD");
});

test("the inactivity timeout reaches the setting the SDK reads, except on Ultravox", () => {
  const agent = makeAgent({ inactivity: { timeout: "8s", message: "Are you still there?" } });
  assert.equal(build("realtime", "livekit:openai/gpt-realtime", agent).sessionOptions.userAwayTimeout, 8);
  assert.equal(build("pipeline", "livekit:openai/gpt-4o-mini", agent).sessionOptions.userAwayTimeout, 8);
  // Ultravox prompts natively, so its session keeps the SDK default.
  assert.equal(build("realtime", "livekit:ultravox/ultravox-v0.7", agent).sessionOptions.userAwayTimeout, 15);
});
