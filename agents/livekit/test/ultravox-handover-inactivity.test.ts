import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";
import { armHandoverFirstSpeaker, HANDOVER_OPENING_INSTRUCTION } from "../lib/handover-opening.js";
import {
  armHandoverInactivity,
  buildRealtimeLlmOptions,
  INACTIVITY_PROMPT_COUNT,
} from "../lib/voice-session-factory.js";
import {
  RealtimeModel,
  withInactivityMessagesOverride,
} from "../plugins/ultravox/src/realtime/realtime_model.js";
import { UltravoxClient } from "../plugins/ultravox/src/realtime/ultravox_client.js";

// Covers options.inactivity across an in-place transfer_agent handover on Ultravox
// realtime. The SDK opens the incoming agent's session from the running
// RealtimeModel, and on Ultravox that session is a new Ultravox call. Its
// inactivityMessages must come from the incoming agent, as they do after a
// full-stack handover, and not from the agent the model was built for.
// run: npx tsx --test test/ultravox-handover-inactivity.test.ts

// The SDK's RealtimeSession base class resolves the logger at construction.
initializeLogger({ pretty: false, level: "fatal" });

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";

// One tool: an Ultravox session creates its call once it has tools.
const TOOLS = {
  transfer_agent: {
    description: "Hand the call to another agent",
    parameters: { type: "object", properties: {} },
  },
} as any;

const makeAgent = (options: Record<string, unknown> = {}) =>
  ({ prompt: "You are a test agent.", options }) as any;

const FIRST = makeAgent({
  inactivity: { timeout: "6s", message: "Are you still there?", hangup: true },
});
const INCOMING = makeAgent({ inactivity: { timeout: "20s", message: "Hello?" } });

const repeated = (entry: Record<string, unknown>) =>
  Array.from({ length: INACTIVITY_PROMPT_COUNT }, () => ({ ...entry }));

/** Stub createCall to record each /calls body and never settle, so nothing is dialled. */
function captureCallBodies(t: TestContext): any[] {
  const bodies: any[] = [];
  t.mock.method(UltravoxClient.prototype, "createCall", (body: unknown) => {
    bodies.push(body);
    return new Promise(() => {});
  });
  return bodies;
}

/** The running model of a call whose first agent is `agent`. */
const runningModel = (agent: any) =>
  new RealtimeModel({ ...buildRealtimeLlmOptions(ULTRAVOX, agent, "call-1"), apiKey: "test-key" } as any);

/** The messages that model was built with. */
const runningModelMessages = (agent: any) =>
  (buildRealtimeLlmOptions(ULTRAVOX, agent, "call-1").vendorSpecific as any).ultravox
    .inactivityMessages;

/** The /calls body of the next session created from `model`. */
async function nextCallBody(model: RealtimeModel, bodies: any[]): Promise<any> {
  const before = bodies.length;
  await model.session().updateTools(TOOLS);
  assert.equal(bodies.length, before + 1, "the session created one Ultravox call");
  return bodies.at(-1);
}

// --- the in-place handover call ------------------------------------------------

test("in place: the incoming agent's call carries its own messages, not the first agent's", async (t) => {
  const bodies = captureCallBodies(t);
  const model = runningModel(FIRST);

  // Unarmed, a new session from the running model keeps the first agent's
  // prompts and its hangup.
  const unarmed = await nextCallBody(model, bodies);
  assert.deepEqual(unarmed.inactivityMessages, runningModelMessages(FIRST));
  assert.equal(unarmed.inactivityMessages.at(-1).endBehavior, "END_BEHAVIOR_HANG_UP_SOFT");

  // Armed, as onAgentTransfer does before llm.handoff().
  assert.equal(armHandoverInactivity(model, INCOMING), true);
  const armed = await nextCallBody(model, bodies);
  assert.deepEqual(armed.inactivityMessages, repeated({ duration: "20s", message: "Hello?" }));
});

test("in place: the override is one-shot", async (t) => {
  const bodies = captureCallBodies(t);
  const model = runningModel(FIRST);
  armHandoverInactivity(model, INCOMING);
  assert.ok(model.pendingInactivityOverride);

  await nextCallBody(model, bodies);
  assert.equal(model.pendingInactivityOverride, undefined);
  // A later session from the model (a consult leg, say) gets the model's own.
  const later = await nextCallBody(model, bodies);
  assert.deepEqual(later.inactivityMessages, runningModelMessages(FIRST));
});

test("in place: an incoming agent without inactivity gets no prompts and no hangup", async (t) => {
  const bodies = captureCallBodies(t);
  const model = runningModel(FIRST);
  assert.equal(armHandoverInactivity(model, makeAgent({})), true);
  const armed = await nextCallBody(model, bodies);
  assert.equal("inactivityMessages" in armed, false);
});

test("in place: the incoming agent's hangup applies when the first agent had none", async (t) => {
  const bodies = captureCallBodies(t);
  const model = runningModel(makeAgent({}));
  armHandoverInactivity(
    model,
    makeAgent({ inactivity: { timeout: 10, message: "Anyone there?", hangup: true } }),
  );
  const armed = await nextCallBody(model, bodies);
  assert.equal(armed.inactivityMessages.length, INACTIVITY_PROMPT_COUNT);
  assert.deepEqual(armed.inactivityMessages.at(-1), {
    duration: "10s",
    message: "Anyone there?",
    endBehavior: "END_BEHAVIOR_HANG_UP_SOFT",
  });
});

test("in place: the incoming agent's native inactivityMessages still win", async (t) => {
  const bodies = captureCallBodies(t);
  const native = [{ duration: "45s", message: "native", endBehavior: "END_BEHAVIOR_UNSPECIFIED" }];
  const model = runningModel(FIRST);
  armHandoverInactivity(
    model,
    makeAgent({
      inactivity: { timeout: "6s", message: "portable", hangup: true },
      vendorSpecific: { ultravox: { inactivityMessages: native } },
    }),
  );
  const armed = await nextCallBody(model, bodies);
  assert.deepEqual(armed.inactivityMessages, native);
});

test("in place: the handover opening and the messages are applied to the same call", async (t) => {
  const bodies = captureCallBodies(t);
  const model = runningModel(FIRST);
  assert.equal(armHandoverFirstSpeaker(model), true);
  assert.equal(armHandoverInactivity(model, INCOMING), true);
  const armed = await nextCallBody(model, bodies);
  assert.deepEqual(armed.firstSpeakerSettings, { agent: { prompt: HANDOVER_OPENING_INSTRUCTION } });
  assert.deepEqual(armed.inactivityMessages, repeated({ duration: "20s", message: "Hello?" }));
  assert.equal(model.pendingFirstSpeakerOverride, undefined);
  assert.equal(model.pendingInactivityOverride, undefined);
});

test("in place matches full stack: the same incoming agent gets the same messages on both paths", async (t) => {
  const bodies = captureCallBodies(t);
  const incomingAgents = {
    none: makeAgent({}),
    portable: INCOMING,
    "portable with hangup": makeAgent({ inactivity: { timeout: 12, message: " Hi? ", hangup: true } }),
    "no message": makeAgent({ inactivity: { timeout: "6s", hangup: true } }),
    native: makeAgent({
      inactivity: { timeout: "6s", message: "portable" },
      vendorSpecific: { ultravox: { inactivityMessages: [{ duration: "9s", message: "native" }] } },
    }),
  };
  for (const [name, incoming] of Object.entries(incomingAgents)) {
    const fullStackModel = new RealtimeModel({
      ...buildRealtimeLlmOptions(ULTRAVOX, incoming, "call-2", { opening: HANDOVER_OPENING_INSTRUCTION }),
      apiKey: "test-key",
    } as any);
    const fullStack = await nextCallBody(fullStackModel, bodies);

    const inPlaceModel = runningModel(FIRST);
    armHandoverInactivity(inPlaceModel, incoming);
    const inPlace = await nextCallBody(inPlaceModel, bodies);

    assert.deepEqual(inPlace.inactivityMessages, fullStack.inactivityMessages, name);
  }
});

test("arming is a no-op for a model without the one-shot override", () => {
  assert.equal(armHandoverInactivity(undefined, INCOMING), false);
  assert.equal(armHandoverInactivity({}, INCOMING), false);
});

// --- the options override --------------------------------------------------------

const FIRST_SPEAKER = { agent: { text: "Hi" } };
const VAD = { minimumInterruptionDuration: "0.48s" };
const OLD = [{ duration: "6s", message: "old" }];
const NEW = [{ duration: "20s", message: "new" }];

const baseOpts = () =>
  ({
    instructions: "test agent",
    vendorSpecific: {
      ultravox: { firstSpeakerSettings: FIRST_SPEAKER, vadSettings: VAD, inactivityMessages: OLD },
    },
  }) as any;

test("no override: the model's messages pass through", () => {
  const opts = withInactivityMessagesOverride(baseOpts(), undefined);
  assert.deepEqual(opts.vendorSpecific!.ultravox!.inactivityMessages, OLD);
});

test("override replaces the messages and keeps sibling vendor options", () => {
  const opts = withInactivityMessagesOverride(baseOpts(), { messages: NEW as any });
  assert.deepEqual(opts.vendorSpecific!.ultravox, {
    firstSpeakerSettings: FIRST_SPEAKER,
    vadSettings: VAD,
    inactivityMessages: NEW,
  });
});

test("an override without messages removes them", () => {
  const opts = withInactivityMessagesOverride(baseOpts(), {});
  assert.deepEqual(opts.vendorSpecific!.ultravox, {
    firstSpeakerSettings: FIRST_SPEAKER,
    vadSettings: VAD,
  });
});

test("override applies when the model had no vendorSpecific at all", () => {
  const opts = withInactivityMessagesOverride({ instructions: "test agent" } as any, {
    messages: NEW as any,
  });
  assert.deepEqual(opts.vendorSpecific, { ultravox: { inactivityMessages: NEW } });
});

test("override does not mutate the model's defaults", () => {
  const base = baseOpts();
  withInactivityMessagesOverride(base, { messages: NEW as any });
  withInactivityMessagesOverride(base, {});
  assert.deepEqual(base.vendorSpecific.ultravox.inactivityMessages, OLD);
});
