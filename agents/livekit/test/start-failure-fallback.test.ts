import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger, JobContext, runWithJobContextAsync, voice } from "@livekit/agents";
import { dispose, Room, RoomEvent } from "@livekit/rtc-node";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { runAgentWorker } from "../lib/voice-agent-runtime.js";
import { releaseFailedAttemptSession } from "../lib/primary-session.js";
import { invocationLogs } from "../lib/invocation-log-buffer.js";
import { finaliseJobBeforeExit } from "../lib/job-finaliser.js";
import { closeSessionBounded } from "../lib/utils.js";
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
/** The `log` of each InvocationLog saved. */
const savedLogs: { reason: string }[] = [];
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
    if (method === "POST" && url === "http://aplisay.test/api/agent-db/invocation-log") {
      savedLogs.push(JSON.parse(String(init?.body)).log);
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  requests.length = 0;
  savedLogs.length = 0;
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
    params,
  }: {
    start?: () => Promise<void>;
    agentDef?: typeof agent;
    failoverAvailable?: boolean;
    params?: Partial<Parameters<typeof runAgentWorker>[0]>;
  } = {},
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
      ...params,
    });
  return { run, ends, messages, session: () => session, starts: () => starts };
}

const failAtCallStart = async () => {
  throw new Error("call start failed");
};

async function waitFor(done: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    assert.ok(Date.now() < deadline, "timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Counts logger.warn calls with `message` until restore(). */
function countWarns(message: string) {
  const warn = logger.warn;
  let count = 0;
  logger.warn = ((...args: unknown[]) => void (args.includes(message) && count++)) as typeof logger.warn;
  return { count: () => count, restore: () => void (logger.warn = warn) };
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

test("the room is joined before the session starts, so a retry never joins it twice", async () => {
  // On staging a retry started while the failed session's own join was in
  // flight, joined the room again, and the second connect dropped the room.
  ultravoxCalls = refuseAfter(20);
  const ctx = fakeJobContext();
  const order: string[] = [];
  const connect = ctx.connect.bind(ctx);
  ctx.connect = async (...args: Parameters<JobContext["connect"]>) => {
    order.push("connect");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await connect(...args);
    order.push("connected");
  };
  const start = voice.AgentSession.prototype.start;
  voice.AgentSession.prototype.start = function (this: voice.AgentSession, ...args: Parameters<typeof start>) {
    order.push("session.start");
    return start.apply(this, args);
  };
  try {
    await runWithJobContextAsync(ctx, async () => {
      const a = attempt(ctx);
      await assert.rejects(a.run(), /Failed to create Ultravox call/);
      await releaseFailedAttemptSession(ctx, a.session());
    });
  } finally {
    voice.AgentSession.prototype.start = start;
  }
  assert.deepEqual(order.slice(0, 3), ["connect", "connected", "session.start"]);
});

test("a failure while the session is still starting lets that start settle before the retry", async () => {
  ultravoxCalls = refuseAfter(0);
  const ctx = fakeJobContext();
  let startSettledAt = 0;
  const start = voice.AgentSession.prototype.start;
  voice.AgentSession.prototype.start = function (this: voice.AgentSession, ...args: Parameters<typeof start>) {
    // A start slower than the refusal.
    return start.apply(this, args).then(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      startSettledAt = Date.now();
      return value;
    });
  };
  try {
    await runWithJobContextAsync(ctx, async () => {
      const a = attempt(ctx);
      await assert.rejects(a.run(), /Failed to create Ultravox call/);
      const rejectedAt = Date.now();
      assert.ok(startSettledAt > 0 && startSettledAt <= rejectedAt, "the failed attempt's start settled first");
      await releaseFailedAttemptSession(ctx, a.session());
    });
  } finally {
    voice.AgentSession.prototype.start = start;
  }
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

test("a job has one shutdown callback, so its failed attempts save one InvocationLog", async () => {
  ultravoxCalls = refuseAfter(20);
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    for (let i = 0; i < 2; i++) {
      const a = attempt(ctx);
      await assert.rejects(a.run(), /Failed to create Ultravox call/);
      await releaseFailedAttemptSession(ctx, a.session());
    }
    invocationLogs.push({ time: Date.now(), msg: "test line" });
    assert.equal(ctx.shutdownCallbacks.length, 1);
    for (const callback of ctx.shutdownCallbacks) {
      await callback();
    }
    assert.equal(savedLogs.length, 1);
  });
});

test("the attempt that runs the call uploads the recording and saves the InvocationLog, once", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as { port: number };
  ultravoxCalls = async () =>
    new Response(JSON.stringify({ callId: "uv-1", joinUrl: `ws://127.0.0.1:${port}/join` }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  const ctx = fakeJobContext();
  // Offline, every upload fails, and each failure is logged.
  const sessionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "recording-once-"));
  (ctx as any)._sessionDirectory = sessionDirectory;
  const uploads = countWarns("RecorderIO OGG not found or upload failed in shutdown callback");
  try {
    await runWithJobContextAsync(ctx, async () => {
      const recorded = { recordingOptions: { enabled: true } };
      // Fails after it set up its recording.
      const failed = attempt(ctx, { start: failAtCallStart, params: recorded });
      await assert.rejects(failed.run(), /call start failed/);
      await releaseFailedAttemptSession(ctx, failed.session());

      const a = attempt(ctx, { failoverAvailable: false, params: recorded });
      await a.run();
      ctx.room.emit(RoomEvent.ParticipantDisconnected, { info: { sid: "PA_caller", identity: "caller" } } as any);
      await waitFor(() => a.ends.length > 0);
      invocationLogs.push({ time: Date.now(), msg: "test line" });
      for (const callback of ctx.shutdownCallbacks) {
        await callback();
      }
      assert.equal(uploads.count(), 1);
      assert.deepEqual(
        savedLogs.map((l) => l.reason),
        ["Unmatched participant disconnect, room empty"],
      );
      await closeSessionBounded(a.session(), 2_000);
    });
  } finally {
    uploads.restore();
    fs.rmSync(sessionDirectory, { recursive: true, force: true });
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("a fallback transfer saves the InvocationLog, with its own reason, before it exits the process", async () => {
  const ctx = fakeJobContext();
  const exits: string[] = [];
  const realExit = process.exit;
  process.exit = ((code?: number) => void exits.push(`exit ${code} after ${savedLogs.length} save`)) as typeof process.exit;
  try {
    await runWithJobContextAsync(ctx, async () => {
      const failed = attempt(ctx, { start: failAtCallStart });
      await assert.rejects(failed.run(), /call start failed/);
      await releaseFailedAttemptSession(ctx, failed.session());

      const caller = { sid: "PA_caller", identity: "caller" };
      const transfer = attempt(ctx, {
        params: {
          transferOnly: true,
          transferArgs: { number: "+441234567892", operation: "blind" },
          participant: caller as any,
        },
      });
      await transfer.run();
      invocationLogs.push({ time: Date.now(), msg: "test line" });
      ctx.room.emit(RoomEvent.ParticipantDisconnected, { info: caller } as any);
      await waitFor(() => exits.length > 0);
      assert.deepEqual(exits, ["exit 0 after 1 save"]);
      assert.deepEqual(transfer.ends, ["Original participant disconnected"]);
      assert.deepEqual(savedLogs.map((l) => l.reason), ["Original participant disconnected"]);
      // agents-js may still reach its shutdown callbacks.
      for (const callback of ctx.shutdownCallbacks) {
        await callback();
      }
      assert.equal(savedLogs.length, 1);
    });
  } finally {
    process.exit = realExit;
  }
});

test("the setup-failure exit saves the failed attempt's InvocationLog, with the failure as its reason, once", async () => {
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    const failed = attempt(ctx, { start: failAtCallStart });
    await assert.rejects(failed.run(), /call start failed/);
    invocationLogs.push({ time: Date.now(), msg: "test line" });
    // What the worker's setup-failure path does before it ends the process.
    await finaliseJobBeforeExit(ctx, "Agent setup failed: call start failed");
    assert.deepEqual(savedLogs.map((l) => l.reason), ["Agent setup failed: call start failed"]);
    for (const callback of ctx.shutdownCallbacks) {
      await callback();
    }
    assert.equal(savedLogs.length, 1);
  });
});
