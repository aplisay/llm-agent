import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { initializeLogger, voice } from "@livekit/agents";
import { createInactivityKick } from "../lib/inactivity-kick.js";
import { verbatimInstructions } from "../lib/speak-text.js";
import { resolveVoiceMode } from "../lib/voice-mode.js";
import {
  createVoiceModelAndSession,
  INACTIVITY_PROMPT_COUNT,
} from "../lib/voice-session-factory.js";

// The inactivity kick across the sessions of one call: the first session, a
// full-stack handover or hand-back, and an in-place handover.
// run: npx tsx --test test/inactivity-kick.test.ts

// The SDK's logger must exist before a model or session is built.
initializeLogger({ pretty: false, level: "fatal" });
// The OpenAI model checks that a key is set. Nothing connects.
process.env.OPENAI_API_KEY ||= "test-key";

const PIPELINE = "livekit:openai/gpt-4o-mini";
const OPENAI = "livekit:openai/gpt-realtime";
const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";

const A_PROMPT = "Agent A: are you still there?";
const B_PROMPT = "Agent B: are you still there?";

/**
 * Advance mocked time in 1s steps. One tick() fires a chained setTimeout at most
 * once, because the next timer is scheduled from the already-advanced clock.
 */
const elapse = (t: TestContext, ms: number) => {
  for (let left = ms; left > 0; left -= 1_000) t.mock.timers.tick(Math.min(1_000, left));
};

const agentWith = (inactivity?: Record<string, unknown>) =>
  ({ prompt: "You are a test agent.", options: inactivity ? { inactivity } : {} }) as any;

/** A stand-in session that records what it is asked to say. */
class FakeSession extends EventEmitter {
  options: { userAwayTimeout?: number | null } = {};
  spoken: string[] = [];

  say(text: string) {
    this.spoken.push(text);
    return { waitForPlayout: async () => {} };
  }

  generateReply(options: { instructions?: string }) {
    this.spoken.push(options.instructions ?? "");
    return { waitForPlayout: async () => {} };
  }

  userState(newState: "speaking" | "listening" | "away") {
    this.emit(voice.AgentSessionEventTypes.UserStateChanged, { newState });
  }
}

/** The runtime state the kick reads, as voice-agent-runtime keeps it. */
const callWith = (agent: any, modelName = PIPELINE) => {
  const call = {
    session: null as any,
    agent,
    modelName,
    bridged: false,
    transferring: false,
    ended: 0,
  };
  const kick = createInactivityKick({
    currentSession: () => call.session,
    activeAgent: () => ({
      agent: call.agent,
      modelName: call.modelName,
      voiceMode: resolveVoiceMode(call.modelName, call.agent.options),
      textOutput: false,
    }),
    isBridged: () => call.bridged,
    transferInFlight: () => call.bridged || call.transferring,
    endCall: async () => {
      call.ended += 1;
    },
  });
  /** A session starts: attach it, then make it current, in the runtime's order. */
  const start = <S>(session: S): S => {
    kick.attach(session as any);
    call.session = session;
    return session;
  };
  return { call, kick, start };
};

test("away: prompts at once, then every timeout, until the caller is back", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, start } = callWith(agentWith({ timeout: "6s", message: A_PROMPT }));
  const s = start(new FakeSession());

  s.userState("away");
  assert.deepEqual(s.spoken, [A_PROMPT]);
  t.mock.timers.tick(5_999);
  assert.equal(s.spoken.length, 1);
  t.mock.timers.tick(1);
  assert.equal(s.spoken.length, 2);

  s.userState("speaking");
  elapse(t, 60_000);
  assert.equal(s.spoken.length, 2);
  assert.equal(call.ended, 0, "no hangup unless the agent opts in");
});

test("no prompt without a usable option, or on Ultravox realtime", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rows: Array<[any, string]> = [
    [agentWith(), PIPELINE],
    [agentWith({ timeout: "6s", message: "  " }), PIPELINE],
    [agentWith({ timeout: "0s", message: A_PROMPT }), PIPELINE],
    // Ultravox prompts natively (inactivityMessages).
    [agentWith({ timeout: "6s", message: A_PROMPT, hangup: true }), ULTRAVOX],
  ];
  for (const [agent, modelName] of rows) {
    const { call, start } = callWith(agent, modelName);
    const s = start(new FakeSession());
    s.userState("away");
    elapse(t, 60_000);
    assert.deepEqual(s.spoken, [], `${modelName} ${JSON.stringify(agent.options)}`);
    assert.equal(call.ended, 0);
  }
});

test("hangup: ends the call after INACTIVITY_PROMPT_COUNT unanswered prompts, and activity resets the count", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, start } = callWith(agentWith({ timeout: 6, message: A_PROMPT, hangup: true }));
  const s = start(new FakeSession());

  s.userState("away");
  elapse(t, 6_000 * (INACTIVITY_PROMPT_COUNT - 2));
  // One prompt short of the limit, the caller answers.
  s.userState("speaking");
  s.userState("listening");

  s.userState("away");
  elapse(t, 6_000 * (INACTIVITY_PROMPT_COUNT - 2));
  assert.equal(call.ended, 0);
  t.mock.timers.tick(6_000);
  assert.equal(call.ended, 1);

  const spoken = s.spoken.length;
  elapse(t, 60_000);
  assert.equal(s.spoken.length, spoken, "no prompts after the hangup");
});

test("hangup: prompts during a transfer do not count, and a bridged caller hears none", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, start } = callWith(agentWith({ timeout: 6, message: A_PROMPT, hangup: true }));
  const s = start(new FakeSession());

  call.transferring = true;
  s.userState("away");
  elapse(t, 6_000 * INACTIVITY_PROMPT_COUNT);
  assert.equal(s.spoken.length, INACTIVITY_PROMPT_COUNT + 1);

  call.transferring = false;
  call.bridged = true;
  elapse(t, 6_000 * INACTIVITY_PROMPT_COUNT);
  assert.equal(s.spoken.length, INACTIVITY_PROMPT_COUNT + 1);
  assert.equal(call.ended, 0);
});

test("full-stack handover: the new session prompts with the incoming agent's options", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, kick, start } = callWith(agentWith({ timeout: 6, message: A_PROMPT }));
  const s1 = start(new FakeSession());
  s1.userState("away");
  assert.deepEqual(s1.spoken, [A_PROMPT]);

  // restartWithAgent: stop once the continuation call is reserved, then start
  // the incoming agent's session on its own model.
  kick.stop();
  call.session = null;
  call.agent = agentWith({ timeout: 10, message: B_PROMPT, hangup: true });
  call.modelName = OPENAI;
  const s2 = start(new FakeSession());
  elapse(t, 60_000);
  assert.deepEqual(s1.spoken, [A_PROMPT]);
  assert.deepEqual(s2.spoken, []);

  s2.userState("away");
  elapse(t, 10_000 * (INACTIVITY_PROMPT_COUNT - 1));
  // OpenAI Realtime in its own voice has no TTS, so the model is asked.
  assert.deepEqual(
    s2.spoken,
    Array(INACTIVITY_PROMPT_COUNT).fill(verbatimInstructions(B_PROMPT, "message")),
  );
  assert.equal(call.ended, 1, "the incoming agent's hangup rule applies");
});

test("hand-back after a bridge: the outgoing agent's prompts never reach the new session", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, start } = callWith(agentWith({ timeout: 6, message: A_PROMPT, hangup: true }));
  const s1 = start(new FakeSession());
  // Bridged to a person, the agent's session hears nothing and goes away.
  call.bridged = true;
  s1.userState("away");
  elapse(t, 60_000);
  assert.deepEqual(s1.spoken, []);

  // The person hands back. Without kick.stop(), the prompts still end with
  // the session that went away.
  call.bridged = false;
  call.agent = agentWith({ timeout: 10, message: B_PROMPT });
  const s2 = start(new FakeSession());
  elapse(t, 60_000);
  assert.deepEqual(s1.spoken, []);
  assert.deepEqual(s2.spoken, []);
  assert.equal(call.ended, 0);
});

test("events from a replaced session are ignored", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { start } = callWith(agentWith({ timeout: 6, message: A_PROMPT }));
  const s1 = start(new FakeSession());
  const s2 = start(new FakeSession());

  s1.userState("away");
  assert.deepEqual(s1.spoken, []);
  assert.deepEqual(s2.spoken, []);

  s2.userState("away");
  s1.userState("speaking");
  t.mock.timers.tick(6_000);
  assert.deepEqual(s2.spoken, [A_PROMPT, A_PROMPT]);
});

test("in-place handover: the running session takes the incoming agent's timeout and prompt", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, kick, start } = callWith(agentWith());
  const s = start(new FakeSession());
  s.options.userAwayTimeout = 15;
  s.userState("away");
  elapse(t, 60_000);
  assert.deepEqual(s.spoken, []);
  s.userState("listening");

  call.agent = agentWith({ timeout: "8s", message: B_PROMPT });
  kick.applyAwayTimeout();
  assert.equal(s.options.userAwayTimeout, 8);
  s.userState("away");
  t.mock.timers.tick(8_000);
  assert.deepEqual(s.spoken, [B_PROMPT, B_PROMPT]);

  // To an agent without the option: the timeout is left as it is, and the
  // prompts stop.
  call.agent = agentWith();
  kick.applyAwayTimeout();
  assert.equal(s.options.userAwayTimeout, 8);
  elapse(t, 60_000);
  assert.deepEqual(s.spoken, [B_PROMPT, B_PROMPT]);
});

test("in-place handover while the caller is away: the next prompt is the incoming agent's", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, kick, start } = callWith(agentWith({ timeout: 6, message: A_PROMPT }));
  const s = start(new FakeSession());
  s.userState("away");

  call.agent = agentWith({ timeout: 10, message: B_PROMPT });
  kick.applyAwayTimeout();
  t.mock.timers.tick(6_000);
  assert.deepEqual(s.spoken, [A_PROMPT, B_PROMPT]);
  t.mock.timers.tick(9_999);
  assert.equal(s.spoken.length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(s.spoken, [A_PROMPT, B_PROMPT, B_PROMPT]);
});

// Exercise real SDK away events and timeout updates; set agent state directly to avoid a room. See PR #340.

/** An OpenAI Realtime session from the factory, recording generateReply calls. */
const factorySession = (agent: any) => {
  const { session } = createVoiceModelAndSession({
    voiceMode: resolveVoiceMode(OPENAI, agent.options),
    modelName: OPENAI,
    agent,
    call: { id: "call-1" } as any,
    tools: {} as any,
  });
  const s = session as any;
  s.spoken = [];
  s.generateReply = (options: { instructions?: string }) => s.spoken.push(options.instructions);
  return s;
};

test("sdk: a handover session goes away after the incoming agent's timeout, and the kick prompts", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const agent = agentWith({ timeout: "2s", message: B_PROMPT });
  const { start } = callWith(agent, OPENAI);
  const s = start(factorySession(agent));

  // The user starts out listening, so an agent that is listening arms the timer.
  s._updateAgentState("listening");
  t.mock.timers.tick(1_999);
  assert.deepEqual(s.spoken, []);
  t.mock.timers.tick(1);
  assert.deepEqual(s.spoken, [verbatimInstructions(B_PROMPT, "message")]);
});

test("sdk: after an in-place handover the session goes away after the incoming agent's timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = agentWith();
  const { call, kick, start } = callWith(first, OPENAI);
  const s = start(factorySession(first));
  assert.equal(s.options.userAwayTimeout, 15, "the SDK default");

  call.agent = agentWith({ timeout: "3s", message: B_PROMPT });
  kick.applyAwayTimeout();
  s._updateAgentState("listening");
  t.mock.timers.tick(3_000);
  assert.deepEqual(s.spoken, [verbatimInstructions(B_PROMPT, "message")]);
});
