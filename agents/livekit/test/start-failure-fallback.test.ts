import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger, JobContext, runWithJobContextAsync, voice } from "@livekit/agents";
import { dispose, Room, RoomEvent } from "@livekit/rtc-node";
import http from "node:http";
import { WebSocketServer } from "ws";
import { runAgentWorker } from "../lib/voice-agent-runtime.js";
import { releaseFailedAttemptSession } from "../lib/primary-session.js";
import { invocationLogs } from "../lib/invocation-log-buffer.js";
import { AgentConcurrencyLimitExceededBusyError } from "../lib/api-client.js";
import logger from "../lib/logger.js";

// A session that fails before the agent first speaks goes back to the worker's
// fallback loop instead of ending the call (docs/agent-failover.md). Offline:
// a fake job with a real, unconnected Room, and fetch stubbed for both the
// Aplisay API and Ultravox, so the real Ultravox plugin makes its /calls request.
// run: npx tsx --test test/start-failure-fallback.test.ts

initializeLogger({ pretty: false, level: "fatal" });
logger.level = "silent";

const realFetch = globalThis.fetch;
const requests: string[] = [];
let ultravoxCalls: () => Promise<Response>;

before(() => {
  Object.assign(process.env, {
    SERVICE_BASE_URI: "http://aplisay.test",
    ULTRAVOX_API_KEY: "test-key",
    LIVEKIT_URL: "http://livekit.test",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (method === "POST" && url === "https://api.ultravox.ai/api/calls") {
      return ultravoxCalls();
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  requests.length = 0;
});

after(async () => {
  globalThis.fetch = realFetch;
  await dispose();
});

const refuseAfter = (ms: number) => () =>
  new Promise<Response>((resolve) =>
    setTimeout(() => resolve(new Response("unavailable", { status: 503, statusText: "Service Unavailable" })), ms),
  );

function fakeJobContext(): JobContext {
  return new JobContext(
    { userData: {} } as any,
    {
      job: { id: "AJ_fallback", room: { name: "room", sid: "RM_fallback" }, attributes: {} },
      url: "ws://localhost:7880",
      token: "",
      workerId: "W_fallback",
      fakeJob: true,
    } as any,
    new Room() as any,
    () => {},
    () => {},
    {} as any,
  );
}

const agent = {
  id: "agent-1",
  userId: "user-1",
  organisationId: "org-1",
  modelName: "livekit:ultravox/ultravox-v0.7",
  prompt: "test",
  // Only an agent with a fallback step has a start-up window.
  options: { fallback: { model: "livekit:ultravox/ultravox-v0.6" } } as Record<string, unknown>,
  // With a tool the plugin creates the Ultravox call as the session starts.
  functions: [
    {
      name: "hang_up",
      description: "End the call",
      implementation: "builtin",
      platform: "hangup",
      input_schema: { type: "object", properties: {} },
    },
  ],
};

function attempt(
  ctx: JobContext,
  {
    start,
    agentDef = agent,
    failoverAvailable,
  }: { start?: () => Promise<void>; agentDef?: typeof agent; failoverAvailable?: boolean } = {},
) {
  let session: voice.AgentSession | null = null;
  const ends: string[] = [];
  const messages: Record<string, unknown>[] = [];
  let starts = 0;
  const call: any = {
    id: "call-1",
    userId: "user-1",
    organisationId: "org-1",
    instanceId: "instance-1",
    agentId: "agent-1",
    start: start ?? (async () => void starts++),
    end: async (reason?: string) => void ends.push(reason ?? ""),
  };
  const run = () =>
    runAgentWorker({
      ctx,
      room: { name: "room" },
      agent: agentDef as any,
      participant: null,
      callerId: "+441234567890",
      calledId: "+441234567891",
      modelName: agentDef.modelName,
      metadata: {},
      sendMessage: async (m: Record<string, unknown>) => void messages.push(m),
      call,
      onHangup: async () => ({ status: "OK" }) as any,
      onTransfer: async () => ({}),
      getBridgedParticipant: () => null,
      setBridgedParticipant: () => {},
      checkForHangup: () => false,
      sessionRef: (s) => (s ? (session = s) : session),
      modelRef: (m) => m,
      getConsultInProgress: () => false,
      getActiveCall: () => call,
      endTransferActivityIfNeeded: async () => {},
      getTransferState: () => ({ state: "none", description: "" }),
      registerHangupExecutor: () => {},
      registerBridgedTakeover: () => {},
      recordingOptions: { enabled: false },
      failoverAvailable,
    });
  return { run, ends, messages, session: () => session, starts: () => starts };
}

const teardownRequests = () =>
  requests.filter((r) => r.includes("livekit.test") || r.includes("/call/call-1/end"));

test("an Ultravox refusal after the session started goes to the fallback loop, not teardown", async () => {
  ultravoxCalls = refuseAfter(50);
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    const a = attempt(ctx);
    await assert.rejects(a.run(), /Failed to create Ultravox call: 503/);
    assert.equal(a.starts(), 1);
    assert.ok(a.session(), "the attempt built and started a session");

    // What the worker does next: close the failed session and clear the primary.
    await releaseFailedAttemptSession(ctx, a.session());
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(a.ends, [], "the call was not ended");
    assert.deepEqual(teardownRequests(), [], "the room was not deleted");
    assert.equal(a.messages.some((m) => "call" in m), false, "no call entry for a failed start");
  });
});

for (const [name, options] of [
  ["without a fallback", { agentDef: { ...agent, options: {} } }],
  ["on the last attempt of a chain", { failoverAvailable: false }],
] as const) test(`${name}, a refusal after the session started ends the call as before`, async () => {
  ultravoxCalls = refuseAfter(50);
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    const a = attempt(ctx, options);
    await a.run();
    // The SDK closes the session on the refusal, and its Close handler tears down.
    while (a.ends.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(a.ends, ["Session closed"]);
    assert.ok(teardownRequests().some((r) => r.includes("livekit.test")), "the room was deleted");
    // End the attempt as the job would, so its timers stop.
    ctx.room.emit(RoomEvent.ParticipantDisconnected, { info: { sid: "PA_caller", identity: "caller" } } as any);
    while (a.ends.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
});

test("a busy refusal at call.start() still fails before the session starts", async () => {
  ultravoxCalls = refuseAfter(0);
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    const a = attempt(ctx, {
      start: async () => {
        throw new AgentConcurrencyLimitExceededBusyError({ scope: "organisation" });
      },
    });
    await assert.rejects(a.run(), (e: any) => e.code === "AGENT_CONCURRENCY_LIMIT_EXCEEDED");
    assert.equal(requests.some((r) => r.includes("ultravox")), false, "no Ultravox call was made");
    await releaseFailedAttemptSession(ctx, a.session());
    assert.deepEqual(a.ends, []);
  });
});

test("the Ultravox socket closing before the agent speaks is a start failure", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (socket) => socket.close(1011, "provider fault"));
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as { port: number };
  ultravoxCalls = async () =>
    new Response(JSON.stringify({ callId: "uv-1", joinUrl: `ws://127.0.0.1:${port}/join` }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  const ctx = fakeJobContext();
  try {
    await runWithJobContextAsync(ctx, async () => {
      const a = attempt(ctx);
      await assert.rejects(a.run(), /provider ended the session during start-up|closed unexpectedly/);
      await releaseFailedAttemptSession(ctx, a.session());
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(a.ends, [], "the provider-ended teardown did not end the call");
      assert.deepEqual(teardownRequests(), []);
    });
  } finally {
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("an OpenAI Realtime connect failure before the agent speaks is a start failure", async () => {
  // A port nothing listens on: the connect is refused. See lib/openai-realtime.ts.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  Object.assign(process.env, {
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  });
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    const a = attempt(ctx, {
      agentDef: { ...agent, modelName: "livekit:openai/gpt-realtime", functions: [] as any },
    });
    await assert.rejects(
      a.run(),
      /provider ended the session during start-up: OpenAI Realtime API connection failed/,
    );
    await releaseFailedAttemptSession(ctx, a.session());
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(a.ends, []);
    assert.deepEqual(teardownRequests(), []);
  });
});

test("a session closed for another reason during start-up ends the call as before", async () => {
  ultravoxCalls = () => new Promise<Response>(() => {});
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    const a = attempt(ctx);
    const running = a.run();
    while (!(a.session() as any)?.started) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const closedAt = Date.now();
    // The SDK closes the session when the caller leaves...
    await a.session()!.close();
    await running;
    assert.ok(Date.now() - closedAt < 5_000, "returned without waiting out the window");
    assert.deepEqual(a.ends, ["Session closed"]);
    assert.ok(teardownRequests().some((r) => r.includes("livekit.test")), "the room was deleted");
    // ...and the room reports it, which runs the full teardown (and stops the attempt's timers).
    ctx.room.emit(RoomEvent.ParticipantDisconnected, { info: { sid: "PA_caller", identity: "caller" } } as any);
    while (a.ends.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
});

test("only the latest attempt's shutdown callback saves the InvocationLog", async () => {
  ultravoxCalls = refuseAfter(20);
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    for (let i = 0; i < 2; i++) {
      const a = attempt(ctx);
      await assert.rejects(a.run(), /Failed to create Ultravox call/);
      await releaseFailedAttemptSession(ctx, a.session());
    }
    invocationLogs.push({ time: Date.now(), msg: "test line" });
    for (const callback of ctx.shutdownCallbacks) {
      await callback("test");
    }
    const saved = requests.filter((r) => r === "POST http://aplisay.test/api/agent-db/invocation-log");
    assert.equal(saved.length, 1);
  });
});
