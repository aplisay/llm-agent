import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeLogger } from "@livekit/agents";
import {
  armHandoverFirstSpeaker,
  HANDOVER_OPENING_INSTRUCTION,
  HandoverAgent,
  isOpeningInstruction,
  openingFirstSpeakerSettings,
  openingReply,
  TAKEOVER_OPENING_INSTRUCTION,
} from "../lib/handover-opening.js";
import { buildRealtimeLlmOptions } from "../lib/voice-session-factory.js";
import { RealtimeModel } from "../plugins/ultravox/src/realtime/realtime_model.js";
import { UltravoxClient } from "../plugins/ultravox/src/realtime/ultravox_client.js";

// Covers the first turn of an agent that takes over a live call: through
// transfer_agent, or when a person hands the call back (bridgedTransferToAgent).
// The caller was greeted when the call started, so the incoming agent opens from
// HANDOVER_OPENING_INSTRUCTION or TAKEOVER_OPENING_INSTRUCTION, not from its
// greeting: on Ultravox through firstSpeakerSettings.agent.prompt on the new
// Ultravox call, on other stacks as its first generateReply.
// run: npx tsx --test test/handover-opening.test.ts

// The SDK's RealtimeSession base class resolves the logger at construction.
initializeLogger({ pretty: false, level: "fatal" });

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const GREETING = "Thanks for calling support, how can I help?";
const greeter = { prompt: "You are support.", options: { greeting: { text: GREETING } } } as any;
const OPENINGS = [HANDOVER_OPENING_INSTRUCTION, TAKEOVER_OPENING_INSTRUCTION];

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

/** A string constant in the Pipecat worker's transfer_prompts.py, joined from its literal parts. */
function pipecatConstant(name: string): string {
  const source = readFileSync(
    new URL("../../pipecat/pipecat_aplisay/transfer_prompts.py", import.meta.url),
    "utf8",
  );
  const block = source.match(new RegExp(`^${name} = \\(\\n([\\s\\S]*?)\\n\\)`, "m"));
  assert.ok(block, `${name} not found in transfer_prompts.py`);
  return [...block[1].matchAll(/"([^"\\]*)"/g)].map((m) => m[1]).join("");
}

test("the instructions are byte-identical to the Pipecat worker's", () => {
  assert.equal(HANDOVER_OPENING_INSTRUCTION, pipecatConstant("HANDOVER_OPENING_INSTRUCTION"));
  assert.equal(TAKEOVER_OPENING_INSTRUCTION, pipecatConstant("TAKEOVER_OPENING_INSTRUCTION"));
});

test("Ultravox opening: agent first, from the instruction, no text, interruptible", () => {
  for (const opening of OPENINGS) {
    assert.deepEqual(openingFirstSpeakerSettings(opening), { agent: { prompt: opening } });
  }
  assert.notEqual(
    openingFirstSpeakerSettings(HANDOVER_OPENING_INSTRUCTION),
    openingFirstSpeakerSettings(HANDOVER_OPENING_INSTRUCTION),
  );
});

test("other stacks: pipeline takes the instruction as user input, realtime as instructions", () => {
  for (const opening of OPENINGS) {
    assert.deepEqual(openingReply("pipeline", opening), { userInput: opening });
    assert.deepEqual(openingReply("realtime", opening), { instructions: opening });
  }
});

test("transcript: only a whole opening instruction counts as a platform turn", () => {
  for (const opening of OPENINGS) {
    assert.equal(isOpeningInstruction(opening), true);
    assert.equal(isOpeningInstruction(`${opening} `), false);
    assert.equal(isOpeningInstruction(opening.slice(0, 40)), false);
  }
  for (const text of ["", "Hello?", GREETING]) {
    assert.equal(isOpeningInstruction(text), false);
  }
});

// --- the Ultravox /calls body --------------------------------------------------

test("full-stack on Ultravox: the handover leg's call opens from the instruction, not the greeting", async (t) => {
  const bodies = captureCallBodies(t);
  const model = ultravoxModel(
    buildRealtimeLlmOptions(ULTRAVOX, greeter, "call-2", { opening: HANDOVER_OPENING_INSTRUCTION }),
  );
  await model.session().updateTools(TOOLS);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].firstSpeakerSettings, { agent: { prompt: HANDOVER_OPENING_INSTRUCTION } });
});

test("hand-back on Ultravox: the takeover leg's call opens from the hand-back instruction, not the greeting", async (t) => {
  const bodies = captureCallBodies(t);
  const model = ultravoxModel(
    buildRealtimeLlmOptions(ULTRAVOX, greeter, "call-3", { opening: TAKEOVER_OPENING_INSTRUCTION }),
  );
  await model.session().updateTools(TOOLS);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].firstSpeakerSettings, { agent: { prompt: TAKEOVER_OPENING_INSTRUCTION } });
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

test("in place on Ultravox after a hand-back: a later handover opens as a handover", async (t) => {
  const bodies = captureCallBodies(t);
  // The running model was built for a hand-back leg.
  const model = ultravoxModel(
    buildRealtimeLlmOptions(ULTRAVOX, greeter, "call-3", { opening: TAKEOVER_OPENING_INSTRUCTION }),
  );
  await model.session().updateTools(TOOLS);
  assert.equal(armHandoverFirstSpeaker(model), true);
  await model.session().updateTools(TOOLS);
  assert.deepEqual(bodies[1].firstSpeakerSettings, { agent: { prompt: HANDOVER_OPENING_INSTRUCTION } });
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
    const opening = openingReply(voiceMode, HANDOVER_OPENING_INSTRUCTION);
    const agent = new HandoverAgent({ instructions: "You are support." }, opening);
    const replies = recordReplies(agent);
    await agent.onEnter();
    assert.deepEqual(replies, [opening]);
  }
});

test("in place on Ultravox: the handoff agent leaves the opening to Ultravox", async () => {
  const agent = new HandoverAgent({ instructions: "You are support." });
  const replies = recordReplies(agent);
  await agent.onEnter();
  assert.deepEqual(replies, []);
});

test("a failed first-turn request does not reject onEnter", async () => {
  const agent = new HandoverAgent(
    { instructions: "You are support." },
    openingReply("realtime", HANDOVER_OPENING_INSTRUCTION),
  );
  (agent as any)._agentActivity = {
    agentSession: {
      generateReply: () => {
        throw new Error("AgentSession is closing, cannot use generateReply()");
      },
    },
  };
  await agent.onEnter();
});
