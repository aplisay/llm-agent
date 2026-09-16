import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";
import {
  clearNextSessionPrimary,
  createProviderEndedTeardown,
  markNextSessionPrimary,
  type ProviderEndedSession,
} from "../lib/provider-ended.js";
import { createVoiceModelAndSession } from "../lib/voice-session-factory.js";

// The provider-ended teardown across the sessions of one call, wired as
// voice-agent-runtime wires it: the first session, an in-place handover, a
// full-stack handover or hand-back, and a consult leg on the running model.
// Where the SDK would open a realtime session (AgentActivity.start), the tests
// call llm.session() themselves. No room, and nothing connects.
// run: npx tsx --test test/provider-ended.test.ts

// The SDK's logger must exist before a model or session is built.
initializeLogger({ pretty: false, level: "fatal" });
// The plugins check that a key is set.
process.env.ULTRAVOX_API_KEY ||= "test-key";
process.env.OPENAI_API_KEY ||= "test-key";

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const OPENAI = "livekit:openai/gpt-realtime";

/** An AgentSession as the runtime builds it. */
const agentSession = (modelName = ULTRAVOX) =>
  createVoiceModelAndSession({
    voiceMode: "realtime",
    modelName,
    agent: { prompt: "You are a test agent.", options: {} } as any,
    call: { id: "call-1" } as any,
    tools: {} as any,
  }).session;

/** The SDK opens a realtime session on the model of `session`. */
const sdkOpens = (session: ProviderEndedSession) => (session.llm as any).session();

/** Ultravox ends `realtimeSession` from its side (the plugin's socket onclose). */
const providerEnds = (session: ProviderEndedSession, realtimeSession: unknown) =>
  (session.llm as any)._notifyProviderEnded(realtimeSession, {
    code: 1000,
    reason: "Time limit reached",
  });

/** The runtime state the hook reads, and the call's first session, armed as the setup path does. */
const startCall = () => {
  const call = {
    session: null as ProviderEndedSession | null,
    cleaningUp: false,
    handover: false,
    bridged: false,
    consult: false,
    ended: 0,
  };
  const teardown = createProviderEndedTeardown({
    currentSession: () => call.session,
    isCleaningUp: () => call.cleaningUp,
    handoverInProgress: () => call.handover,
    isBridged: () => call.bridged,
    consultInProgress: () => call.consult,
    endCall: async () => {
      call.ended += 1;
    },
  });
  const first = agentSession();
  call.session = first;
  assert.equal(teardown.arm(first, { callId: "call-1", modelName: ULTRAVOX }), true);
  return { call, teardown, first, firstRt: sdkOpens(first) };
};

/** restartWithAgent: swap in a new model and arm it, in the runtime's order. */
const fullStackHandover = (
  { call, teardown }: ReturnType<typeof startCall>,
) => {
  call.handover = true;
  call.session = null;
  const next = agentSession();
  assert.equal(teardown.arm(next, { callId: "call-2", modelName: ULTRAVOX }), true);
  call.session = next;
  const nextRt = sdkOpens(next);
  call.handover = false;
  return { next, nextRt };
};

test("first session: the provider ending it ends the call", () => {
  const { call, first, firstRt } = startCall();
  providerEnds(first, firstRt);
  assert.equal(call.ended, 1);
});

test("the call stays up while the end is expected", () => {
  for (const flag of ["cleaningUp", "handover", "bridged", "consult"] as const) {
    const { call, first, firstRt } = startCall();
    call[flag] = true;
    providerEnds(first, firstRt);
    assert.equal(call.ended, 0, flag);
  }
});

test("in place: the incoming agent's session ends the call, the outgoing one does not", () => {
  const { call, first, firstRt } = startCall();
  // onAgentTransfer marks the model. The SDK then closes the outgoing session
  // and opens the incoming agent's on the same model.
  assert.equal(markNextSessionPrimary(first.llm), true);
  const incomingRt = sdkOpens(first);

  providerEnds(first, firstRt);
  assert.equal(call.ended, 0, "the caller no longer hears the outgoing session");
  providerEnds(first, incomingRt);
  assert.equal(call.ended, 1);
});

test("full-stack handover or hand-back: the new model ends the call, the replaced one does not", () => {
  const state = startCall();
  const { next, nextRt } = fullStackHandover(state);

  providerEnds(state.first, state.firstRt);
  assert.equal(state.call.ended, 0, "the replaced model no longer speaks to the caller");
  providerEnds(next, nextRt);
  assert.equal(state.call.ended, 1);
});

test("full-stack, then in place on the new model: the hook follows both", () => {
  const state = startCall();
  const { next, nextRt } = fullStackHandover(state);
  assert.equal(markNextSessionPrimary(next.llm), true);
  const incomingRt = sdkOpens(next);

  providerEnds(next, nextRt);
  assert.equal(state.call.ended, 0);
  providerEnds(next, incomingRt);
  assert.equal(state.call.ended, 1);
});

test("consult leg: its session never ends the call, even with a handover mark left behind", () => {
  const { call, first, firstRt } = startCall();
  // The SDK skipped a handover after the mark was set (it ignores the switch
  // when one turn returns two agent tasks), so the mark is still on the model.
  markNextSessionPrimary(first.llm);
  // transfer-handler builds the consult AgentSession on the primary's model.
  // Its end can arrive before setConsultInProgress(true), which the consult
  // guard needs, so the consult session must never be primary.
  const consult = { llm: first.llm };
  clearNextSessionPrimary(consult.llm);
  const consultRt = sdkOpens(consult);

  providerEnds(consult, consultRt);
  assert.equal(call.ended, 0);
  providerEnds(first, firstRt);
  assert.equal(call.ended, 1, "the caller's session still ends the call");
});

test("a model that does not report provider-ended: nothing is armed or marked", () => {
  const { teardown } = startCall();
  const openai = agentSession(OPENAI);
  assert.equal(teardown.arm(openai, { callId: "call-1", modelName: OPENAI }), false);
  assert.equal(teardown.arm({}, { callId: "call-1", modelName: "none" }), false);
  assert.equal(markNextSessionPrimary(openai.llm), false);
  assert.equal(markNextSessionPrimary(undefined), false);
  clearNextSessionPrimary(openai.llm);
  clearNextSessionPrimary(undefined);
});
