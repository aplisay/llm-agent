import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { initializeLogger } from "@livekit/agents";
import {
  armHandoverToolReactions,
  buildRealtimeLlmOptions,
  ultravoxToolReactions,
} from "../lib/voice-session-factory.js";
import {
  RealtimeModel,
  clientToolResultMessage,
  withToolReactionsOverride,
} from "../plugins/ultravox/src/realtime/realtime_model.js";
import { UltravoxClient } from "../plugins/ultravox/src/realtime/ultravox_client.js";

// Ultravox takes a new turn after every tool result unless the result says otherwise. After
// `hangup` that turn can only call hangup again, so it looped (up to 11 calls on v0.9.55).
// The hangup result must carry `agentReaction: "listens"`; every other tool keeps the default.
// See PR #354. Run: npx tsx --test test/ultravox-tool-reactions.test.ts

// The SDK's RealtimeSession base class resolves the logger at construction.
initializeLogger({ pretty: false, level: "fatal" });

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";

const builtin = (name: string, platform: string) => ({
  name,
  implementation: "builtin",
  platform,
  description: `${platform} builtin`,
  input_schema: { properties: {} },
});
const rest = (name: string) => ({
  name,
  implementation: "rest",
  description: "a REST function",
  input_schema: { properties: {} },
});

const makeAgent = (functions: unknown[]) =>
  ({ prompt: "You are a test agent.", options: {}, functions }) as any;

const FIRST = makeAgent([builtin("hangup", "hangup"), rest("lookup")]);
// The same builtin under a name the customer chose.
const INCOMING = makeAgent([builtin("end_call", "hangup"), rest("lookup")]);

// --- which tools get a reaction --------------------------------------------------

test("the hangup builtin listens; other functions get nothing", () => {
  assert.deepEqual(ultravoxToolReactions(FIRST), { hangup: "listens" });
});

test("the reaction is keyed by the function's own name, not the builtin's", () => {
  assert.deepEqual(ultravoxToolReactions(INCOMING), { end_call: "listens" });
});

test("a user function that is merely NAMED hangup is left alone", () => {
  assert.equal(ultravoxToolReactions(makeAgent([rest("hangup")])), undefined);
});

test("other builtins and an agent with no functions get no reactions", () => {
  assert.equal(
    ultravoxToolReactions(makeAgent([builtin("transfer", "transfer"), rest("lookup")])),
    undefined,
  );
  assert.equal(ultravoxToolReactions({ prompt: "x", options: {} } as any), undefined);
});

test("only an Ultravox model is given toolReactions", () => {
  assert.deepEqual(buildRealtimeLlmOptions(ULTRAVOX, FIRST, "call-1").toolReactions, {
    hangup: "listens",
  });
  assert.equal(
    "toolReactions" in buildRealtimeLlmOptions("livekit:openai/gpt-realtime", FIRST, "call-1"),
    false,
  );
});

// --- the frame -----------------------------------------------------------------

test("a result with no reaction omits agentReaction, so Ultravox applies its default", () => {
  assert.deepEqual(clientToolResultMessage("inv-1", '{"ok":true}'), {
    type: "client_tool_result",
    invocationId: "inv-1",
    result: '{"ok":true}',
  });
});

test("a result with a reaction carries it", () => {
  assert.deepEqual(clientToolResultMessage("inv-1", "{}", "listens"), {
    type: "client_tool_result",
    invocationId: "inv-1",
    result: "{}",
    agentReaction: "listens",
  });
});

// --- through a live session ------------------------------------------------------

const TOOLS = Object.fromEntries(
  ["hangup", "end_call", "lookup"].map((name) => [
    name,
    {
      description: name,
      parameters: { type: "object", properties: {} },
      execute: async () => JSON.stringify({ status: "OK", tool: name }),
    },
  ]),
) as any;
TOOLS.broken = {
  description: "always throws",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    throw new Error("boom");
  },
};

/**
 * Stand in for Ultravox: a local WebSocket server the session joins in place of
 * the real call. Returns `invoke`, which sends one client_tool_invocation to a new
 * session of `model` and resolves with the client_tool_result frame it answers with.
 */
async function ultravoxStub(t: TestContext) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;
  t.mock.method(UltravoxClient.prototype, "createCall", async () => ({
    callId: "uv-test",
    joinUrl: `ws://127.0.0.1:${port}/`,
  }));
  t.mock.method(UltravoxClient.prototype, "deleteCall", async () => {});
  t.after(() => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });

  return async (model: RealtimeModel, toolName: string): Promise<any> => {
    const connected = once(wss, "connection") as Promise<[WebSocket]>;
    const session = model.session();
    const created = once(session as any, "session_created");
    await session.updateTools(TOOLS);
    const [socket] = await connected;
    // The session attaches its message handler just after it emits session_created.
    await created;
    await new Promise((resolve) => setImmediate(resolve));

    const frame = new Promise<any>((resolve) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "client_tool_result") resolve(message);
      });
    });
    socket.send(
      JSON.stringify({
        type: "client_tool_invocation",
        toolName,
        invocationId: `inv-${toolName}`,
        parameters: {},
      }),
    );
    const result = await frame;
    await session.close();
    return result;
  };
}

const runningModel = (agent: any) =>
  new RealtimeModel({ ...buildRealtimeLlmOptions(ULTRAVOX, agent, "call-1"), apiKey: "test-key" } as any);

test("live: the hangup result tells Ultravox to listen", async (t) => {
  const invoke = await ultravoxStub(t);
  const frame = await invoke(runningModel(FIRST), "hangup");
  assert.equal(frame.invocationId, "inv-hangup");
  assert.equal(frame.agentReaction, "listens");
  assert.equal(frame.result, JSON.stringify({ status: "OK", tool: "hangup" }));
});

test("live: any other tool's result leaves the reaction to Ultravox", async (t) => {
  const invoke = await ultravoxStub(t);
  const frame = await invoke(runningModel(FIRST), "lookup");
  assert.equal(frame.invocationId, "inv-lookup");
  assert.equal("agentReaction" in frame, false);
});

test("live: a tool that throws reports the error and no reaction", async (t) => {
  const invoke = await ultravoxStub(t);
  const model = new RealtimeModel({
    ...buildRealtimeLlmOptions(ULTRAVOX, FIRST, "call-1"),
    toolReactions: { broken: "listens" },
    apiKey: "test-key",
  } as any);
  const frame = await invoke(model, "broken");
  assert.equal(frame.errorType, "implementation-error");
  assert.equal("agentReaction" in frame, false);
});

// --- the in-place handover ---------------------------------------------------------

test("in place: the incoming agent's hangup name listens, and the override is one-shot", async (t) => {
  const invoke = await ultravoxStub(t);
  const model = runningModel(FIRST);

  // Unarmed, the running model only knows the first agent's name for it.
  assert.equal("agentReaction" in (await invoke(model, "end_call")), false);

  // Armed, as onAgentTransfer does before llm.handoff().
  assert.equal(armHandoverToolReactions(model, INCOMING), true);
  assert.equal((await invoke(model, "end_call")).agentReaction, "listens");

  // A later session from the model (a consult leg, say) gets the model's own.
  assert.equal("agentReaction" in (await invoke(model, "end_call")), false);
  assert.equal((await invoke(model, "hangup")).agentReaction, "listens");
});

test("in place: an incoming agent with no hangup builtin clears the outgoing agent's", async (t) => {
  const invoke = await ultravoxStub(t);
  const model = runningModel(FIRST);
  armHandoverToolReactions(model, makeAgent([rest("lookup")]));
  assert.equal("agentReaction" in (await invoke(model, "hangup")), false);
});

test("arming is a no-op for a model without the one-shot override", () => {
  assert.equal(armHandoverToolReactions({}, INCOMING), false);
  assert.equal(armHandoverToolReactions(null, INCOMING), false);
});

// --- the override helper -------------------------------------------------------------

const BASE = { toolReactions: { hangup: "listens" } } as any;

test("no override: the model's reactions pass through", () => {
  assert.deepEqual(withToolReactionsOverride(BASE).toolReactions, { hangup: "listens" });
});

test("an override replaces them, and one without reactions removes them", () => {
  assert.deepEqual(
    withToolReactionsOverride(BASE, { reactions: { end_call: "listens" } }).toolReactions,
    { end_call: "listens" },
  );
  assert.equal(withToolReactionsOverride(BASE, {}).toolReactions, undefined);
});

test("an override does not mutate the model's defaults", () => {
  withToolReactionsOverride(BASE, { reactions: { end_call: "listens" } });
  assert.deepEqual(BASE.toolReactions, { hangup: "listens" });
});
