import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";
import { RealtimeModel } from "../plugins/ultravox/src/realtime/realtime_model.js";

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

test("notifying before any session exists is a no-op", () => {
  const model = makeModel();
  let calls = 0;
  model.setProviderEndedCallback(() => {
    calls += 1;
  });
  notify(model, { anything: true });
  assert.equal(calls, 0);
});
