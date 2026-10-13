import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";
import { createConsultSession, createVoiceModelAndSession } from "../lib/voice-session-factory.js";

// The warm-transfer consult session. A realtime one runs on the primary session's
// model: with an external TTS that model sends text only, so a consult session
// with no TTS of its own left the transfer target in silence. A pipeline one had
// no STT or TTS at all.
// run: npx tsx --test test/consult-session.test.ts

initializeLogger({ pretty: false, level: "fatal" });

// The plugins only check that a key is present when the model is built.
for (const key of ["OPENAI_API_KEY", "ULTRAVOX_API_KEY", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) {
  process.env[key] ??= "test-key";
}

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const PIPELINE = "livekit:openai/gpt-4o-mini";

const makeAgent = (modelName: string, options: Record<string, unknown> = {}) =>
  ({ prompt: "You are a test agent.", modelName, options }) as any;

const buildPrimary = (agent: any, vad?: any) =>
  createVoiceModelAndSession({
    voiceMode: agent.modelName === PIPELINE ? "pipeline" : "realtime",
    modelName: agent.modelName,
    agent,
    call: { id: "call-1" } as any,
    tools: undefined as any,
    vad,
  }).session as any;

/** The consult session for a call whose primary session was built from `primaryAgent`. */
const consultFor = (primaryAgent: any, voiceAgent = primaryAgent, vad?: any) => {
  const primary = buildPrimary(primaryAgent, vad);
  const consult = createConsultSession({
    primaryLlm: primary.llm,
    agent: voiceAgent,
    modelName: voiceAgent.modelName,
    vad,
  }) as any;
  return { primary, consult };
};

test("text-output realtime agents: the consult session has its own TTS on the primary's model", () => {
  for (const modelName of [ULTRAVOX, "livekit:openai/gpt-realtime"]) {
    const agent = makeAgent(modelName, { tts: { vendor: "elevenlabs", voice: "Rachel" } });
    const { primary, consult } = consultFor(agent);
    assert.equal(primary.llm.capabilities.audioOutput, false, `${modelName}: model sends text only`);
    assert.equal(consult.llm, primary.llm, modelName);
    assert.ok(consult.tts, `${modelName}: consult session has a TTS`);
    assert.notEqual(consult.tts, primary.tts, `${modelName}: not the primary's TTS instance`);
  }
});

test("native-voice realtime agents: the consult session has no TTS", () => {
  for (const agent of [
    makeAgent(ULTRAVOX, { tts: { vendor: "ultravox", voice: "Mark" } }),
    makeAgent(ULTRAVOX),
    makeAgent("livekit:openai/gpt-realtime", { tts: { vendor: "openai", voice: "alloy" } }),
  ]) {
    const { primary, consult } = consultFor(agent);
    assert.equal(primary.llm.capabilities.audioOutput, true, agent.modelName);
    assert.equal(consult.tts, undefined, agent.modelName);
  }
});

test("after a handover the consult TTS is built from the agent now speaking", () => {
  const first = makeAgent(ULTRAVOX, { tts: { vendor: "cartesia", voice: "abc" } });
  const second = makeAgent(ULTRAVOX, { tts: { vendor: "elevenlabs", voice: "Rachel" } });
  const { consult } = consultFor(first, second);
  assert.match(consult.tts.model, /^elevenlabs\//);
});

test("an in-place handover to an agent with no external TTS keeps a TTS on the text-only model", () => {
  const first = makeAgent(ULTRAVOX, { tts: { vendor: "cartesia", voice: "abc" } });
  const second = makeAgent(ULTRAVOX);
  const { consult } = consultFor(first, second);
  assert.ok(consult.tts, "the running model still sends text only");
});

test("the realtime consult session keeps the legacy turn-taking and the realtime idle timeouts", () => {
  const { consult } = consultFor(makeAgent(ULTRAVOX, { tts: { vendor: "cartesia", voice: "x" } }));
  const o = consult.sessionOptions;
  assert.equal(consult.vad, undefined);
  assert.equal(consult.turnDetection, undefined);
  assert.equal(o.aecWarmupDuration, null);
  assert.equal(o.turnHandling.preemptiveGeneration.enabled, false);
  assert.equal(o.turnHandling.interruption.resumeFalseInterruption, false);
  assert.ok(o.forwardAudioIdleTimeout > 10_000);
  assert.ok(o.ttsReadIdleTimeout > 10_000);
});

test("pipeline agents: the consult session has its own STT, LLM and TTS", () => {
  const agent = makeAgent(PIPELINE, { tts: { vendor: "elevenlabs", voice: "Rachel" } });
  const { primary, consult } = consultFor(agent);
  for (const part of ["stt", "llm", "tts"]) {
    assert.ok(consult[part], `consult session has ${part}`);
    assert.notEqual(consult[part], primary[part], `${part} is not the primary's instance`);
  }
  assert.match(consult.tts.model, /^elevenlabs\//);
  assert.equal(consult.turnDetection, "stt");
  assert.equal(consult.sessionOptions.turnHandling.preemptiveGeneration.enabled, false);
});

test("pipeline agents: the consult session turns on the prewarmed VAD when there is one", () => {
  const prewarmed = { label: "silero.VAD" };
  const { consult } = consultFor(makeAgent(PIPELINE), makeAgent(PIPELINE), prewarmed);
  assert.equal(consult.vad, prewarmed);
  assert.equal(consult.turnDetection, "vad");
});
