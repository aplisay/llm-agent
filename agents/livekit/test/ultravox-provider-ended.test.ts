import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";
import { RealtimeModel } from "../plugins/ultravox/src/realtime/realtime_model.js";
import { createVoiceModelAndSession } from "../lib/voice-session-factory.js";

// When Ultravox ends a session we did not ask it to end — its own maxDuration, an
// options.inactivity.hangup endBehavior hangup, or an outage — the agent is dead but
// the SIP leg is still up. The SDK cannot tell us: AgentSession.Error forwards the
// INNER Error, so the RealtimeModelError wrapper's `recoverable` is stripped before any
// listener sees it, and the Close event never arrives because closeImpl blocks in
// drain(). Hence the out-of-band provider-ended callback these tests lock down.
//
// The dangerous failure mode is a FALSE POSITIVE — ending a healthy call — so the
// primary-session scoping is what most of this file is about.
// run: npx tsx --test test/ultravox-provider-ended.test.ts

initializeLogger({ pretty: false, level: "fatal" });

const makeModel = () =>
  new RealtimeModel({ instructions: "test", apiKey: "test-key" } as any);

/** Model internals under test are keyed off session identity, not call state. */
const notify = (model: any, session: unknown, info = { code: 1000 }) =>
  model._notifyProviderEnded(session, info);

test("no callback registered: notifying is a no-op, not a throw", () => {
  const model = makeModel();
  const s = model.session();
  notify(model, s);
});

test("primary session: the callback fires with the close info", () => {
  const model = makeModel();
  const seen: unknown[] = [];
  model.setProviderEndedCallback((i: unknown) => seen.push(i));

  const primary = model.session();
  notify(model, primary, { code: 1000, reason: "Time limit reached" } as any);

  assert.deepEqual(seen, [{ code: 1000, reason: "Time limit reached" }]);
});

test("consult/handover sessions must NOT fire it", () => {
  // The consult TransferAgent session and post-handover sessions share the model
  // instance. Their ending is routine; tearing down the primary call would be a
  // catastrophic false positive.
  const model = makeModel();
  let calls = 0;
  model.setProviderEndedCallback(() => {
    calls += 1;
  });

  model.session(); // primary
  const consult = model.session(); // consult TransferAgent
  const handover = model.session(); // later full-stack handover

  notify(model, consult);
  notify(model, handover);
  assert.equal(calls, 0, "only the primary session may end the call");
});

test("primary stays the FIRST session even after later sessions exist", () => {
  const model = makeModel();
  const seen: unknown[] = [];
  model.setProviderEndedCallback((i: unknown) => seen.push(i));

  const primary = model.session();
  model.session();
  model.session();

  notify(model, primary, { code: 1006 } as any);
  assert.deepEqual(seen, [{ code: 1006 }]);
});

test("an unknown session object is ignored", () => {
  const model = makeModel();
  let calls = 0;
  model.setProviderEndedCallback(() => {
    calls += 1;
  });
  model.session();
  notify(model, { not: "a session" });
  assert.equal(calls, 0);
});

test("callback is replaceable and only the latest fires", () => {
  const model = makeModel();
  const first: unknown[] = [];
  const second: unknown[] = [];
  model.setProviderEndedCallback((i: unknown) => first.push(i));
  model.setProviderEndedCallback((i: unknown) => second.push(i));

  const primary = model.session();
  notify(model, primary);

  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
});

// --- the wiring contract ---------------------------------------------------
// This is the test that was missing. The hook shipped once bound to the wrong
// object: createVoiceModelAndSession returns `model` as the voice.Agent (behaviour),
// while the RealtimeModel is constructed inline and reachable ONLY via session.llm.
// The runtime called setProviderEndedCallback on the Agent through an optional call,
// so it silently no-opped and the defect looked unfixed in production. Assert the
// exact object the runtime reaches for.

const evalAgent = () =>
  ({
    id: "agent-1",
    userId: "u",
    organisationId: "o",
    modelName: "livekit:ultravox/ultravox-v0.6",
    prompt: "You are a test agent.",
    options: { tts: { vendor: "ultravox", voice: "Eanna" } },
  }) as any;

test("session.llm — not the returned model — carries setProviderEndedCallback", () => {
  // The plugin's constructor requires a key; nothing here reaches the network.
  process.env.ULTRAVOX_API_KEY ||= "test-key";
  const { session, model } = createVoiceModelAndSession({
    voiceMode: "realtime",
    modelName: "livekit:ultravox/ultravox-v0.6",
    agent: evalAgent(),
    call: { id: "call-1" } as any,
    tools: {} as any,
  });

  assert.equal(
    typeof (session.llm as any)?.setProviderEndedCallback,
    "function",
    "the runtime hooks session.llm; it must expose the callback",
  );
  assert.equal(
    typeof (model as any)?.setProviderEndedCallback,
    "undefined",
    "`model` is the voice.Agent — hooking it is the bug this test exists to catch",
  );
});

test("notifying before any session exists is a no-op", () => {
  const model = makeModel();
  let calls = 0;
  model.setProviderEndedCallback(() => {
    calls += 1;
  });
  notify(model, { anything: true });
  assert.equal(calls, 0);
});
