import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger, JobContext, runWithJobContextAsync, voice } from "@livekit/agents";
import { dispose, Room, RoomEvent } from "@livekit/rtc-node";
import { runAgentWorker } from "../lib/voice-agent-runtime.js";
import logger from "../lib/logger.js";

// After a transfer bridge, getActiveCall() returns the bridged tail leg. The agent session's
// usage must still land on the agent's own call: the bridged leg is billed only for its own
// audio-path minutes. Aux and output STT usage go through the same meters and flush.
// Offline, on the harness of start-failure-fallback.test.ts.
// run: npx tsx --test test/bridged-usage-attribution.test.ts

initializeLogger({ pretty: false, level: "fatal" });
logger.level = "silent";

const realFetch = globalThis.fetch;
const usagePosts: any[] = [];

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
    if (url === "http://aplisay.test/api/agent-db/usage") {
      usagePosts.push(JSON.parse(String(init?.body)));
    }
    // Ultravox never answers, so the session stays up until the test closes it.
    if (url === "https://api.ultravox.ai/api/calls") return new Promise<Response>(() => {});
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await dispose();
});

function fakeJobContext(): JobContext {
  return new JobContext(
    { userData: {} } as any,
    {
      job: { id: "AJ_usage", room: { name: "room", sid: "RM_usage" }, attributes: {} },
      url: "ws://localhost:7880",
      token: "",
      workerId: "W_usage",
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
  modelName: "livekit:ultravox/ultravox-v0.6",
  prompt: "test",
  options: {},
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

const fakeCall = (id: string, ends: string[]): any => ({
  id,
  userId: "user-1",
  organisationId: "org-1",
  instanceId: "instance-1",
  agentId: "agent-1",
  start: async () => {},
  end: async () => void ends.push(id),
});

test("after a bridge, the agent session's usage lands on the agent call, not the bridged leg", async () => {
  const ctx = fakeJobContext();
  const ends: string[] = [];
  const call = fakeCall("call-1", ends);
  const bridged = fakeCall("bridged-1", ends);
  let bridgeUp = false;
  let session: voice.AgentSession | null = null;

  await runWithJobContextAsync(ctx, async () => {
    const running = runAgentWorker({
      ctx,
      room: { name: "room" },
      agent: agent as any,
      participant: null,
      callerId: "+441234567890",
      calledId: "+441234567891",
      modelName: agent.modelName,
      metadata: {},
      sendMessage: async () => {},
      call,
      onHangup: async () => ({ status: "OK" }) as any,
      onTransfer: async () => ({}),
      getBridgedParticipant: () => null,
      setBridgedParticipant: () => {},
      checkForHangup: () => false,
      sessionRef: (s) => (s ? (session = s) : session),
      modelRef: (m) => m,
      getConsultInProgress: () => false,
      // As setupCallAndUtilities in worker.ts builds them.
      getActiveCall: () => (bridgeUp ? bridged : call),
      getAgentCall: () => call,
      endTransferActivityIfNeeded: async () => {},
      getTransferState: () => ({ state: "none", description: "" }),
      registerHangupExecutor: () => {},
      registerBridgedTakeover: () => {},
      recordingOptions: { enabled: false },
    });
    while (!(session as any)?.started) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    session!.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      metrics: { type: "realtime_model_metrics", label: "ultravox", inputTokens: 100, outputTokens: 20 },
    } as any);

    // The bridge is up, then the caller hangs up: the runtime flushes usage and ends the call.
    bridgeUp = true;
    ctx.room.emit(RoomEvent.ParticipantDisconnected, { info: { sid: "PA_caller", identity: "caller" } } as any);
    while (!ends.length) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const records = usagePosts.flatMap((p) => p.records);
    assert.deepEqual(
      records.map((r) => [r.callId, r.sessionId, r.technology, r.unit, r.quantity]),
      [
        ["call-1", "call-1", "llm", "input_tokens", 100],
        ["call-1", "call-1", "llm", "output_tokens", 20],
      ],
    );
    // Teardown still ends the bridged leg, which bills its own minutes.
    assert.deepEqual(new Set(ends), new Set(["bridged-1"]));
    await session!.close();
    await running;
  });
});
