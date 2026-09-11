import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeLogger } from "@livekit/agents";
import {
  armHandoverFirstSpeaker,
  HANDOVER_OPENING_INSTRUCTION,
  HandoverAgent,
  handoverFirstSpeakerSettings,
  handoverOpeningReply,
} from "../lib/handover-opening.js";
import { buildRealtimeLlmOptions } from "../lib/voice-session-factory.js";
import { RealtimeModel } from "../plugins/ultravox/src/realtime/realtime_model.js";
import { UltravoxClient } from "../plugins/ultravox/src/realtime/ultravox_client.js";

// Covers the first turn of an agent that takes over a live call through
// transfer_agent. The caller was greeted when the call started, so the incoming
// agent opens from HANDOVER_OPENING_INSTRUCTION, not from its greeting: on
// Ultravox through firstSpeakerSettings.agent.prompt on the new Ultravox call
// (full-stack and in place), on other stacks as its first generateReply.
// run: npx tsx --test test/handover-opening.test.ts

// The SDK's RealtimeSession base class resolves the logger at construction.
initializeLogger({ pretty: false, level: "fatal" });

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const GREETING = "Thanks for calling support, how can I help?";
const greeter = { prompt: "You are support.", options: { greeting: { text: GREETING } } } as any;

// One tool: an Ultravox session creates its call once it has tools.
const TOOLS = {
  transfer_agent: {
    description: "Hand the call to another agent",
    parameters: { type: "object", properties: {} },
  },
} as any;

/** Stub createCall to record each /calls body and never settle, so nothing is dialled. */
function captureCallBodies(t: TestContext): any[] {
  const bodies: any[] = [];
  t.mock.method(UltravoxClient.prototype, "createCall", (body: unknown) => {
    bodies.push(body);
    return new Promise(() => {});
  });
  return bodies;
}

const ultravoxModel = (options: Record<string, unknown>) =>
  new RealtimeModel({ ...options, apiKey: "test-key" } as any);

test("the instruction is byte-identical to the Pipecat worker's", () => {
  const source = readFileSync(
    new URL("../../pipecat/pipecat_aplisay/transfer_prompts.py", import.meta.url),
    "utf8",
  );
  const block = source.match(/^HANDOVER_OPENING_INSTRUCTION = \(\n([\s\S]*?)\n\)/m);
  assert.ok(block, "HANDOVER_OPENING_INSTRUCTION not found in transfer_prompts.py");
  const pipecat = [...block[1].matchAll(/"([^"\\]*)"/g)].map((m) => m[1]).join("");
  assert.equal(HANDOVER_OPENING_INSTRUCTION, pipecat);
});

test("Ultravox opening: agent first, from the instruction, no text, interruptible", () => {
  assert.deepEqual(handoverFirstSpeakerSettings(), {
    agent: { prompt: HANDOVER_OPENING_INSTRUCTION },
  });
  assert.notEqual(handoverFirstSpeakerSettings(), handoverFirstSpeakerSettings());
});

test("other stacks: pipeline takes the instruction as user input, realtime as instructions", () => {
  assert.deepEqual(handoverOpeningReply("pipeline"), { userInput: HANDOVER_OPENING_INSTRUCTION });
  assert.deepEqual(handoverOpeningReply("realtime"), { instructions: HANDOVER_OPENING_INSTRUCTION });
});

// --- the Ultravox /calls body --------------------------------------------------

test("full-stack on Ultravox: the handover leg's call opens from the instruction, not the greeting", async (t) => {
  const bodies = captureCallBodies(t);
  const model = ultravoxModel(buildRealtimeLlmOptions(ULTRAVOX, greeter, "call-2", { handover: true }));
  await model.session().updateTools(TOOLS);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].firstSpeakerSettings, { agent: { prompt: HANDOVER_OPENING_INSTRUCTION } });
});

test("in place on Ultravox: the incoming agent's call opens from the instruction, not the model's greeting", async (t) => {
  const bodies = captureCallBodies(t);
  // The running model was built for a first-leg agent with a greeting.
  const model = ultravoxModel(buildRealtimeLlmOptions(ULTRAVOX, greeter, "call-1"));
  // Unarmed, a new session from it opens with that greeting.
  await model.session().updateTools(TOOLS);
  assert.deepEqual(bodies[0].firstSpeakerSettings, { agent: { uninterruptible: true, text: GREETING } });
  // Armed, as onAgentTransfer does before llm.handoff(): the next session opens
  // from the instruction.
  assert.equal(armHandoverFirstSpeaker(model), true);
  await model.session().updateTools(TOOLS);
  assert.deepEqual(bodies[1].firstSpeakerSettings, { agent: { prompt: HANDOVER_OPENING_INSTRUCTION } });
  // One-shot: a later session (a consult leg, say) is not affected.
  assert.equal(model.pendingFirstSpeakerOverride, undefined);
});

test("arming is a no-op for a model without the one-shot override", () => {
  assert.equal(armHandoverFirstSpeaker(undefined), false);
  assert.equal(armHandoverFirstSpeaker({}), false);
});

// --- the in-place handoff agent ------------------------------------------------

/** Attach a stub activity whose session records the generateReply calls. */
function recordReplies(agent: HandoverAgent): unknown[] {
  const replies: unknown[] = [];
  // `agent.session` resolves through the agent's activity, which the SDK sets on start.
  (agent as any)._agentActivity = {
    agentSession: { generateReply: (options: unknown) => replies.push(options) },
  };
  return replies;
}

test("in place on other stacks: the handoff agent's first turn is the handover opening", async () => {
  for (const voiceMode of ["pipeline", "realtime"] as const) {
    const agent = new HandoverAgent({ instructions: "You are support." }, handoverOpeningReply(voiceMode));
    const replies = recordReplies(agent);
    await agent.onEnter();
    assert.deepEqual(replies, [handoverOpeningReply(voiceMode)]);
  }
});

test("in place on Ultravox: the handoff agent leaves the opening to Ultravox", async () => {
  const agent = new HandoverAgent({ instructions: "You are support." });
  const replies = recordReplies(agent);
  await agent.onEnter();
  assert.deepEqual(replies, []);
});

test("a failed first-turn request does not reject onEnter", async () => {
  const agent = new HandoverAgent({ instructions: "You are support." }, handoverOpeningReply("realtime"));
  (agent as any)._agentActivity = {
    agentSession: {
      generateReply: () => {
        throw new Error("AgentSession is closing, cannot use generateReply()");
      },
    },
  };
  await agent.onEnter();
});
