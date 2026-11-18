import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger, JobContext, runWithJobContextAsync, voice } from "@livekit/agents";
import { dispose, Room, RoomEvent } from "@livekit/rtc-node";
import { runAgentWorker } from "../lib/voice-agent-runtime.js";
import { invocationLogs } from "../lib/invocation-log-buffer.js";
import logger from "../lib/logger.js";

// A call that ends while a consultative transfer is live must end both its own
// record and the consult leg's before the job process exits. agents-js shuts the
// job down as soon as the room is deleted and exits the process when its
// shutdown callbacks return, so here deleting the room runs those callbacks at
// once, the earliest the real SDK can. A record left `in progress` holds an
// agent-concurrency slot until something ends it, and nothing else does.
// run: npx tsx --test test/consult-records-end.test.ts

initializeLogger({ pretty: false, level: "fatal" });
logger.level = "silent";

const realFetch = globalThis.fetch;
/** Runs the job's shutdown callbacks, as agents-js does once the room has gone. */
let onRoomDeleted: (() => void) | null = null;

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
    // The Ultravox call never comes: the session starts and stays up.
    if (method === "POST" && url === "https://api.ultravox.ai/api/calls") {
      return new Promise<Response>(() => {});
    }
    if (url.startsWith("http://livekit.test") && url.endsWith("/DeleteRoom")) {
      onRoomDeleted?.();
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  onRoomDeleted = null;
});

after(async () => {
  globalThis.fetch = realFetch;
  await dispose();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(done: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    assert.ok(Date.now() < deadline, "timed out waiting");
    await sleep(10);
  }
}

function fakeJobContext(): JobContext {
  return new JobContext(
    { userData: {} } as any,
    {
      job: { id: "AJ_consult", room: { name: "room", sid: "RM_consult" }, attributes: {} },
      url: "ws://localhost:7880",
      token: "",
      workerId: "W_consult",
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
  options: {},
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

/**
 * A call with a consult in progress. Ending the consult takes a while (closing
 * the TransferAgent session, deleting the consult room, ending its record), and
 * so does ending the call (the user turn timings fetch, then the POST).
 */
function callInConsult(ctx: JobContext, { callEndMs }: { callEndMs: number }) {
  let session: voice.AgentSession | null = null;
  const callEnds: string[] = [];
  const consultEnds: string[] = [];
  const consult = { inProgress: true, ending: null as Promise<void> | null };
  let callEnding: Promise<void> | null = null;
  const call: any = {
    id: "call-1",
    userId: "user-1",
    organisationId: "org-1",
    instanceId: "instance-1",
    agentId: "agent-1",
    start: async () => {},
    // Like the real Call: a second end() gets the first one's promise.
    end: (reason?: string) =>
      (callEnding ??= (async () => {
        await sleep(callEndMs);
        callEnds.push(reason ?? "");
      })()),
  };
  // Like the worker's destroyInProgressTransfer: a no-op once the consult is over.
  const endConsult = (reason: string): Promise<void> => {
    if (!consult.inProgress) return Promise.resolve();
    consult.ending ??= (async () => {
      await sleep(300);
      consultEnds.push(reason);
      consult.inProgress = false;
    })();
    return consult.ending;
  };
  const run = () =>
    runAgentWorker({
      ctx,
      room: { name: "room" },
      agent: agent as any,
      participant: { identity: "caller", sid: "PA_caller" } as any,
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
      getConsultInProgress: () => consult.inProgress,
      getActiveCall: () => call,
      getAgentCall: () => call,
      endTransferActivityIfNeeded: endConsult,
      getTransferState: () => ({ state: consult.inProgress ? "talking" : "none", description: "" }),
      registerHangupExecutor: () => {},
      registerBridgedTakeover: () => {},
      recordingOptions: { enabled: false },
      failoverAvailable: false,
    });
  return { run, callEnds, consultEnds, consult, session: () => session };
}

/** Deleting the room runs the job's shutdown callbacks; resolves when they have returned. */
function shutDownJobWhenRoomDeleted(ctx: JobContext) {
  let finished: Promise<unknown> | null = null;
  onRoomDeleted = () => {
    finished ??= Promise.allSettled(ctx.shutdownCallbacks.map((cb) => cb()));
  };
  return async () => {
    await waitFor(() => finished !== null);
    await finished;
  };
}

async function startedCall(ctx: JobContext, callEndMs = 100) {
  const c = callInConsult(ctx, { callEndMs });
  await c.run();
  await waitFor(() => Boolean((c.session() as any)?.started));
  // Something for the shutdown callback to save.
  invocationLogs.push({ time: Date.now(), msg: "test line" });
  return c;
}

/** Ends the attempt so its timers stop, whatever the test found. */
async function finish(ctx: JobContext, c: ReturnType<typeof callInConsult>) {
  await c.consult.ending;
  ctx.room.emit(RoomEvent.ParticipantDisconnected, { info: { sid: "PA_other", identity: "other" } } as any);
  await waitFor(() => c.callEnds.length > 0);
}

test("a session that closes during a consult ends both records before the job exits", async () => {
  // For example, the provider ends the agent's session at its time limit while
  // the consult is live.
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    const c = await startedCall(ctx);
    const jobExit = shutDownJobWhenRoomDeleted(ctx);
    try {
      await c.session()!.close();
      await jobExit();
      assert.deepEqual(c.consultEnds, ["Session closed"], "the consult leg's record ended before the exit");
      assert.deepEqual(c.callEnds, ["Session closed"], "the call's record ended before the exit");
    } finally {
      await finish(ctx, c);
    }
  });
});

test("a caller who hangs up during a consult: both records end before the job exits", async () => {
  // The caller leaves mid-consult. The SDK closes the session (closeOnDisconnect),
  // and the Close handler deletes the room while the call's end is in flight.
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    const c = await startedCall(ctx, 1_500);
    const jobExit = shutDownJobWhenRoomDeleted(ctx);
    try {
      ctx.room.emit(RoomEvent.ParticipantDisconnected, { info: { sid: "PA_caller", identity: "caller" } } as any);
      // The session closes once the consult has ended, while the call's end is in flight.
      await sleep(350);
      await c.session()!.close();
      await jobExit();
      assert.deepEqual(c.consultEnds, ["Original participant disconnected"]);
      assert.deepEqual(c.callEnds, ["Original participant disconnected"]);
    } finally {
      await finish(ctx, c);
    }
  });
});
