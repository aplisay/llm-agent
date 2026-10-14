import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { inference, initializeLogger, JobContext, llm, runWithJobContextAsync, stt, voice } from "@livekit/agents";
import { dispose, Room, RoomEvent } from "@livekit/rtc-node";
import { runAgentWorker } from "../lib/voice-agent-runtime.js";
import type { BridgedTakeoverRuntime } from "../lib/bridged-transfer-to-agent.js";
import logger from "../lib/logger.js";

// A full-stack handover (transfer_agent to another model, or a human handing a bridged call back
// to an agent) starts a continuation call. The outgoing agent's usage must be written to its own
// call at that point, with its own vendors, and the incoming agent metered from zero. An in-place
// handover keeps one call and one set of meters. Offline, on the harness of
// bridged-usage-attribution.test.ts.
// run: npx tsx --test test/handover-usage-split.test.ts

initializeLogger({ pretty: false, level: "fatal" });
logger.level = "silent";

const BASE = "http://aplisay.test";
const realFetch = globalThis.fetch;
const realFromModelString = inference.STT.fromModelString;
/** Usage POSTs, API writes and call ends, in the order they reached the API. */
let events: string[] = [];
let usagePosts: any[] = [];
let agents: Record<string, any> = {};

/**
 * The output-audit engine. Like the real engines, it reports its last usage interval a while
 * after the flush that dispose() asks for, inside dispose's 300 ms grace period.
 */
class FakeSideStt extends EventEmitter {
  label = "fake.SideSTT";
  stream() {
    let finish = () => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    return {
      pushFrame: () => {},
      flush: () => {
        setTimeout(() => this.emit("metrics_collected", { audioDurationMs: 1500 }), 100);
      },
      endInput: () => finish(),
      close: () => finish(),
      async *[Symbol.asyncIterator](): AsyncGenerator<stt.SpeechEvent> {
        await done;
      },
    };
  }
  async close() {}
}

before(() => {
  Object.assign(process.env, {
    SERVICE_BASE_URI: BASE,
    ULTRAVOX_API_KEY: "test-key",
    LIVEKIT_URL: "http://livekit.test",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
  });
  delete process.env.LIVEKIT_PIPELINE_USE_PROVIDER_KEYS;
  (inference.STT as any).fromModelString = () => new FakeSideStt();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === `${BASE}/api/agent-db/usage`) {
      const body = JSON.parse(String(init?.body));
      usagePosts.push(body);
      events.push(`usage ${[...new Set(body.records.map((r: any) => r.callId))].join(",")}`);
      return json({});
    }
    if (url.startsWith(`${BASE}/api/agent-db/agent?`)) {
      return json(agents[new URL(url).searchParams.get("agentId")!]);
    }
    if (url === `${BASE}/api/agent-db/call` && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      events.push(`create ${body.agentId}`);
      return json({ ...body, id: "call-2" });
    }
    const end = /\/api\/agent-db\/call\/([^/]+)\/end$/.exec(url);
    if (end) events.push(`end ${end[1]}`);
    // Ultravox never answers, so each session stays up until the test closes it.
    if (url === "https://api.ultravox.ai/api/calls") return new Promise<Response>(() => {});
    return json({});
  }) as typeof fetch;
});

beforeEach(() => {
  events = [];
  usagePosts = [];
});

after(async () => {
  globalThis.fetch = realFetch;
  (inference.STT as any).fromModelString = realFromModelString;
  await dispose();
});

function fakeJobContext(): JobContext {
  return new JobContext(
    { userData: {} } as any,
    {
      job: { id: "AJ_split", room: { name: "room", sid: "RM_split" }, attributes: {} },
      url: "ws://localhost:7880",
      token: "",
      workerId: "W_split",
      fakeJob: true,
    } as any,
    new Room() as any,
    () => {},
    () => {},
    {} as any,
  );
}

const transferTo = (target: string) => ({
  name: "transfer_agent",
  description: "Hand the caller to another agent",
  implementation: "builtin",
  platform: "transfer_agent",
  input_schema: { type: "object", properties: { agent: { type: "string", source: "static", from: target } } },
});

const agentDef = (id: string, model: string, extra: Record<string, any> = {}) => ({
  id,
  name: id,
  userId: "user-1",
  organisationId: "org-1",
  type: "interactive-audio",
  modelName: `livekit:ultravox/${model}`,
  prompt: `You are ${id}.`,
  options: {},
  functions: [],
  keys: [],
  ...extra,
});

const fakeCall = (id: string, agentId: string): any => ({
  id,
  userId: "user-1",
  organisationId: "org-1",
  instanceId: "instance-1",
  agentId,
  start: async () => {},
  end: async () => void events.push(`end ${id}`),
});

const realtimeMetrics = (inputTokens: number, outputTokens: number) =>
  ({ metrics: { type: "realtime_model_metrics", label: "ultravox", inputTokens, outputTokens } }) as any;

async function until(done: () => boolean, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Run the agent's transfer_agent builtin as the model would call it. */
const transferAgent = (agent: voice.Agent) =>
  (new Map(llm.sortedToolEntries(agent.toolCtx)).get("transfer_agent") as any).execute({}, {});

const rows = (post: any) =>
  post.records.map((r: any) => [r.callId, r.agentId, r.technology, r.provider, r.detail, r.unit, r.quantity, r.finalised]);

/** Run one call on `first`, as setupCallAndUtilities in worker.ts wires the call accessors. */
async function runCall(
  first: any,
  script: (h: {
    session: () => voice.AgentSession;
    model: () => voice.Agent;
    takeover: () => BridgedTakeoverRuntime;
    setBridged: (c: any) => void;
    hangUp: () => Promise<void>;
  }) => Promise<void>,
) {
  const ctx = fakeJobContext();
  const call = fakeCall("call-1", first.id);
  let activeAgentCall: any = call;
  let bridgedCallRecord: any = null;
  let session: voice.AgentSession | null = null;
  let model: voice.Agent | null = null;
  let takeoverRt: BridgedTakeoverRuntime | null = null;

  await runWithJobContextAsync(ctx, async () => {
    const running = runAgentWorker({
      ctx,
      room: { name: "room" },
      agent: first,
      participant: null,
      callerId: "+441234567890",
      calledId: "+441234567891",
      modelName: first.modelName,
      metadata: {},
      sendMessage: async () => {},
      call,
      onHangup: async () => ({ status: "OK" }) as any,
      onTransfer: async () => ({}),
      getBridgedParticipant: () => null,
      setBridgedParticipant: () => {},
      checkForHangup: () => false,
      sessionRef: (s) => (s ? (session = s) : session),
      modelRef: (m) => (m ? (model = m) : model),
      getConsultInProgress: () => false,
      getActiveCall: () => bridgedCallRecord || activeAgentCall,
      getAgentCall: () => activeAgentCall,
      setActiveAgentCall: (next) => (activeAgentCall = next),
      endTransferActivityIfNeeded: async () => {},
      getTransferState: () => ({ state: "none", description: "" }),
      registerHangupExecutor: () => {},
      registerBridgedTakeover: (rt) => (takeoverRt = rt ?? takeoverRt),
      recordingOptions: { enabled: false },
    });
    await until(() => Boolean((session as any)?.started), "the first session to start");
    let lastSession: voice.AgentSession | null = null;
    const callEnds = () => events.filter((e) => e.startsWith("end ")).length;
    const disconnectCaller = () =>
      ctx.room.emit(RoomEvent.ParticipantDisconnected, { info: { sid: "PA_caller", identity: "caller" } } as any);
    let tornDown = false;
    try {
      await script({
        session: () => session!,
        model: () => model!,
        takeover: () => takeoverRt!,
        setBridged: (c) => (bridgedCallRecord = c),
        hangUp: async () => {
          lastSession = session;
          tornDown = true;
          const ends = callEnds();
          disconnectCaller();
          await until(() => callEnds() > ends, "teardown to end the call");
        },
      });
    } finally {
      // A failed script must still tear the call down, or its timers keep the test process alive.
      if (!tornDown) disconnectCaller();
      await (lastSession ?? session)?.close();
      await running;
    }
  });
}

test("transfer_agent to another model writes the outgoing agent's usage to its own call", async () => {
  agents = {
    "agent-1": agentDef("agent-1", "ultravox-v0.6", {
      functions: [transferTo("agent-2")],
      options: { tts: { output: true } },
    }),
    "agent-2": agentDef("agent-2", "ultravox-v0.7"),
  };
  await runCall(agents["agent-1"], async ({ session, model, hangUp }) => {
    const first = session();
    first.emit(voice.AgentSessionEventTypes.MetricsCollected, realtimeMetrics(100, 20));

    await transferAgent(model());
    assert.notEqual(session(), first, "a new session runs the incoming agent");

    // The outgoing agent's usage, its output audit included, is on its call before the call ends.
    assert.deepEqual(events, ["create agent-2", "usage call-1", "end call-1"]);
    assert.deepEqual(rows(usagePosts[0]), [
      ["call-1", "agent-1", "llm", "ultravox", "ultravox/ultravox-v0.6", "input_tokens", 100, true],
      ["call-1", "agent-1", "llm", "ultravox", "ultravox/ultravox-v0.6", "output_tokens", 20, true],
      ["call-1", "agent-1", "stt-output", "deepgram", "deepgram/nova-3", "milliseconds", 1500, true],
    ]);

    session().emit(voice.AgentSessionEventTypes.MetricsCollected, realtimeMetrics(7, 3));
    await hangUp();
    assert.equal(usagePosts.length, 2);
    // The incoming agent's rows carry its own model, and none of the outgoing agent's usage.
    assert.deepEqual(rows(usagePosts[1]), [
      ["call-2", "agent-2", "llm", "ultravox", "ultravox/ultravox-v0.7", "input_tokens", 7, true],
      ["call-2", "agent-2", "llm", "ultravox", "ultravox/ultravox-v0.7", "output_tokens", 3, true],
    ]);
  });
});

test("a bridged takeover writes the outgoing agent's usage to the original agent call", async () => {
  agents = {
    "agent-1": agentDef("agent-1", "ultravox-v0.6", { options: { tts: { output: true } } }),
    "agent-2": agentDef("agent-2", "ultravox-v0.7"),
  };
  const bridged = fakeCall("bridged-1", "agent-1");
  bridged.parentId = "call-1";
  await runCall(agents["agent-1"], async ({ session, takeover, setBridged, hangUp }) => {
    session().emit(voice.AgentSessionEventTypes.MetricsCollected, realtimeMetrics(100, 20));

    // The bridge comes up and the agent's media is detached, as finaliseBridgedCall does.
    setBridged(bridged);
    takeover().onPrimaryAgentDetached!();
    // The transfer target hands the caller back at once, before the audit's last report lands.
    await takeover().takeover({
      newAgentDef: agents["agent-2"],
      instructions: "You are agent-2.",
      parentCall: bridged,
      parentId: "call-1",
      onReserved: async () => {
        setBridged(null);
        await bridged.end("handed back");
      },
    });

    assert.deepEqual(events, ["create agent-2", "end bridged-1", "usage call-1"]);
    assert.deepEqual(rows(usagePosts[0]), [
      ["call-1", "agent-1", "llm", "ultravox", "ultravox/ultravox-v0.6", "input_tokens", 100, true],
      ["call-1", "agent-1", "llm", "ultravox", "ultravox/ultravox-v0.6", "output_tokens", 20, true],
      ["call-1", "agent-1", "stt-output", "deepgram", "deepgram/nova-3", "milliseconds", 1500, true],
    ]);

    session().emit(voice.AgentSessionEventTypes.MetricsCollected, realtimeMetrics(7, 3));
    await hangUp();
    assert.deepEqual(rows(usagePosts[1]), [
      ["call-2", "agent-2", "llm", "ultravox", "ultravox/ultravox-v0.7", "input_tokens", 7, true],
      ["call-2", "agent-2", "llm", "ultravox", "ultravox/ultravox-v0.7", "output_tokens", 3, true],
    ]);
    assert.equal(usagePosts.flatMap((p) => p.records).filter((r: any) => r.callId === "bridged-1").length, 0);
  });
});

test("an output audit stopped at the bridge still reports to the teardown flush", async () => {
  agents = { "agent-1": agentDef("agent-1", "ultravox-v0.6", { options: { tts: { output: true } } }) };
  const bridged = fakeCall("bridged-1", "agent-1");
  await runCall(agents["agent-1"], async ({ session, takeover, setBridged, hangUp }) => {
    session().emit(voice.AgentSessionEventTypes.MetricsCollected, realtimeMetrics(100, 20));
    setBridged(bridged);
    takeover().onPrimaryAgentDetached!();
    // The caller hangs up before the audit's last report lands.
    await hangUp();

    assert.deepEqual(events, ["usage call-1", "end bridged-1"]);
    assert.deepEqual(rows(usagePosts[0]), [
      ["call-1", "agent-1", "llm", "ultravox", "ultravox/ultravox-v0.6", "input_tokens", 100, true],
      ["call-1", "agent-1", "llm", "ultravox", "ultravox/ultravox-v0.6", "output_tokens", 20, true],
      ["call-1", "agent-1", "stt-output", "deepgram", "deepgram/nova-3", "milliseconds", 1500, true],
    ]);
  });
});

test("an in-place handover keeps one call and one set of meters", async () => {
  agents = {
    "agent-1": agentDef("agent-1", "ultravox-v0.6", { functions: [transferTo("agent-2")] }),
    "agent-2": agentDef("agent-2", "ultravox-v0.6", { functions: [transferTo("agent-1")] }),
  };
  await runCall(agents["agent-1"], async ({ session, model, hangUp }) => {
    const only = session();
    only.emit(voice.AgentSessionEventTypes.MetricsCollected, realtimeMetrics(100, 20));

    await transferAgent(model());
    assert.equal(session(), only, "the running session takes the incoming agent");
    assert.deepEqual(events, [], "no continuation call and no flush");

    only.emit(voice.AgentSessionEventTypes.MetricsCollected, realtimeMetrics(7, 3));
    await hangUp();
    assert.equal(usagePosts.length, 1);
    assert.deepEqual(rows(usagePosts[0]), [
      ["call-1", "agent-1", "llm", "ultravox", "ultravox/ultravox-v0.6", "input_tokens", 107, true],
      ["call-1", "agent-1", "llm", "ultravox", "ultravox/ultravox-v0.6", "output_tokens", 23, true],
    ]);
  });
});
