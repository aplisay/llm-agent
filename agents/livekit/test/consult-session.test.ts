import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";
import { createConsultSession, createVoiceModelAndSession } from "../lib/voice-session-factory.js";

// The warm-transfer consult session runs on the primary session's model. With an
// external TTS that model sends text only, so a consult session with no TTS of its
// own left the transfer target in silence.
// run: npx tsx --test test/consult-session.test.ts

initializeLogger({ pretty: false, level: "fatal" });

// The plugins only check that a key is present when the model is built.
for (const key of ["OPENAI_API_KEY", "ULTRAVOX_API_KEY", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) {
  process.env[key] ??= "test-key";
}

const makeAgent = (modelName: string, options: Record<string, unknown> = {}) =>
  ({ prompt: "You are a test agent.", modelName, options }) as any;

const primaryAndConsult = (agent: any) => {
  const { session: primary } = createVoiceModelAndSession({
    voiceMode: "realtime",
    modelName: agent.modelName,
    agent,
    call: { id: "call-1" } as any,
    tools: undefined as any,
  });
  return { primary: primary as any, consult: createConsultSession(primary.llm!, agent) as any };
};

test("text-output realtime agents: the consult session has its own TTS on the primary's model", () => {
  for (const modelName of ["livekit:ultravox/ultravox-v0.7", "livekit:openai/gpt-realtime"]) {
    const agent = makeAgent(modelName, { tts: { vendor: "elevenlabs", voice: "Rachel" } });
    const { primary, consult } = primaryAndConsult(agent);
    assert.equal(primary.llm.capabilities.audioOutput, false, `${modelName}: model sends text only`);
    assert.equal(consult.llm, primary.llm, modelName);
    assert.ok(consult.tts, `${modelName}: consult session has a TTS`);
    assert.notEqual(consult.tts, primary.tts, `${modelName}: not the primary's TTS instance`);
  }
});

test("native-voice realtime agents: the consult session has no TTS", () => {
  for (const agent of [
    makeAgent("livekit:ultravox/ultravox-v0.7", { tts: { vendor: "ultravox", voice: "Mark" } }),
    makeAgent("livekit:ultravox/ultravox-v0.7"),
    makeAgent("livekit:openai/gpt-realtime", { tts: { vendor: "openai", voice: "alloy" } }),
  ]) {
    const { primary, consult } = primaryAndConsult(agent);
    assert.equal(primary.llm.capabilities.audioOutput, true, agent.modelName);
    assert.equal(consult.tts, undefined, agent.modelName);
  }
});

test("the consult session keeps the legacy turn-taking and the realtime idle timeouts", () => {
  const agent = makeAgent("livekit:ultravox/ultravox-v0.7", { tts: { vendor: "cartesia", voice: "x" } });
  const { consult } = primaryAndConsult(agent);
  const o = consult.sessionOptions;
  assert.equal(consult.vad, undefined);
  assert.equal(consult.turnDetection, undefined);
  assert.equal(o.aecWarmupDuration, null);
  assert.equal(o.turnHandling.preemptiveGeneration.enabled, false);
  assert.equal(o.turnHandling.interruption.resumeFalseInterruption, false);
  assert.ok(o.forwardAudioIdleTimeout > 10_000);
  assert.ok(o.ttsReadIdleTimeout > 10_000);
});
