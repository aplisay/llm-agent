import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGED_HANDOVER_ENDED_REASON,
  openBridgedCallRecord,
} from "../lib/transfer-handler.js";
import type { Call } from "../lib/api-client.js";

// A transfer target that hangs up right after being connected must not leave
// the bridged-call record live: teardown ends whatever is registered as active,
// and Call.start() would revive an ended record. Staging, 2026-10-15: two
// records stayed open with their concurrency slots held.
// run: npx tsx --test test/bridged-call-handover.test.ts

type Step = string;

function fakeCall(id: string, steps: Step[], hooks: { onEnd?: () => void; onStart?: () => void } = {}): Call {
  return {
    id,
    start: async () => {
      steps.push(`${id}.start`);
      hooks.onStart?.();
    },
    end: async (reason?: string) => {
      steps.push(`${id}.end(${reason})`);
      hooks.onEnd?.();
    },
  } as unknown as Call;
}

function scenario(tearDownDuring?: "create" | "agentEnd" | "start") {
  const steps: Step[] = [];
  let tearingDown = false;
  const tearDown = () => {
    tearingDown = true;
    steps.push("teardown");
  };
  const agentCall = fakeCall("agent", steps, { onEnd: tearDownDuring === "agentEnd" ? tearDown : undefined });
  const bridged = fakeCall("bridged", steps, { onStart: tearDownDuring === "start" ? tearDown : undefined });
  const run = () =>
    openBridgedCallRecord({
      agentCall,
      teardownStarted: () => tearingDown,
      register: (c) => steps.push(`register(${c.id})`),
      create: async () => {
        steps.push("create");
        if (tearDownDuring === "create") tearDown();
        return bridged;
      },
    });
  return { steps, run, tearDown };
}

test("a normal handover ends the agent call, then starts and registers the bridged record", async () => {
  const { steps, run } = scenario();
  const result = await run();
  assert.equal(result?.id, "bridged");
  assert.deepEqual(steps, [
    "create",
    "agent.end(Agent left call, new bridged call: bridged)",
    "bridged.start",
    "register(bridged)",
  ]);
});

test("once teardown has started no bridged record is created", async () => {
  const { steps, run, tearDown } = scenario();
  tearDown();
  assert.equal(await run(), null);
  assert.deepEqual(steps, ["teardown"]);
});

test("a hang-up while the record is created ends it without ever starting it", async () => {
  const { steps, run } = scenario("create");
  assert.equal(await run(), null);
  assert.deepEqual(steps, [
    "create",
    "teardown",
    "agent.end(Agent left call, new bridged call: bridged)",
    `bridged.end(${BRIDGED_HANDOVER_ENDED_REASON})`,
  ]);
});

test("a hang-up while the agent call ends also leaves the record unstarted and ended", async () => {
  const { steps, run } = scenario("agentEnd");
  assert.equal(await run(), null);
  assert.ok(!steps.includes("bridged.start"));
  assert.equal(steps.at(-1), `bridged.end(${BRIDGED_HANDOVER_ENDED_REASON})`);
});

test("a hang-up before the record is registered ends it after registration", async () => {
  const { steps, run } = scenario("start");
  assert.equal(await run(), null);
  assert.deepEqual(steps.slice(-3), ["teardown", "register(bridged)", `bridged.end(${BRIDGED_HANDOVER_ENDED_REASON})`]);
});

test("no bridged record created means the agent call is left to its caller", async () => {
  const steps: Step[] = [];
  const result = await openBridgedCallRecord({
    agentCall: fakeCall("agent", steps),
    teardownStarted: () => false,
    register: () => steps.push("register"),
    create: async () => null,
  });
  assert.equal(result, null);
  assert.deepEqual(steps, []);
});
