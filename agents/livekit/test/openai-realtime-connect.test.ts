import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { initializeLogger, JobContext, llm, runWithJobContextAsync, voice } from "@livekit/agents";
import { OpenAIRealtimeModel } from "../lib/openai-realtime.js";
import { createProviderEndedTeardown } from "../lib/provider-ended.js";
import { createVoiceModelAndSession } from "../lib/voice-session-factory.js";

// @livekit/agents-plugin-openai 1.9 has no 'error' listener on its connecting socket, so a failed
// connect was an uncaught exception that ended the job process. Offline: a local server that
// refuses, rejects or never answers the upgrade, and real sessions with no room.
// run: npx tsx --test test/openai-realtime-connect.test.ts

initializeLogger({ pretty: false, level: "fatal" });
process.env.OPENAI_API_KEY = "sk-test";

const LIVEKIT_DIR = fileURLToPath(new URL("..", import.meta.url));

type Upgrade = { answer(status: number): void };

/** The upgrade path picks the reply: /ok accepts, /hang never answers, /held waits for the test, /<status> rejects. */
async function startUpgradeServer() {
  const sockets = new Set<net.Socket>();
  const held: Upgrade[] = [];
  const events = new EventEmitter();
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.on("upgrade", (req, socket, head) => {
    const upgrade: Upgrade = {
      answer: (status) =>
        socket.end(
          `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        ),
    };
    const mode = req.url!.split("/")[1];
    if (mode === "ok") {
      wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", () => events.emit("message")));
    } else if (mode === "held") {
      held.push(upgrade);
      events.emit("held");
    } else if (mode !== "hang") {
      upgrade.answer(Number(mode));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as net.AddressInfo;
  return {
    baseURL: (mode: string) => `http://127.0.0.1:${port}/${mode}/v1`,
    async nextHeld() {
      while (!held.length) await once(events, "held");
      return held.shift()!;
    },
    nextMessage: () => once(events, "message"),
    close() {
      for (const s of sockets) s.destroy();
      wss.close();
      server.close();
    },
  };
}

/** A port that was just listening, so a connect to it is refused. */
async function refusedBaseURL() {
  const s = net.createServer().listen(0, "127.0.0.1");
  await once(s, "listening");
  const { port } = s.address() as net.AddressInfo;
  await new Promise((resolve) => s.close(resolve));
  return `http://127.0.0.1:${port}/v1`;
}

let server: Awaited<ReturnType<typeof startUpgradeServer>>;
let refused: string;
before(async () => {
  server = await startUpgradeServer();
  refused = await refusedBaseURL();
});
after(() => server.close());

const model = (baseURL: string, timeoutMs = 10_000) =>
  new OpenAIRealtimeModel({
    apiKey: "sk-test",
    baseURL,
    connOptions: { maxRetry: 3, retryIntervalMs: 2_000, timeoutMs },
  } as any);

/** The first error a realtime session reports. */
const firstError = (session: llm.RealtimeSession) =>
  once(session, "error").then(([ev]) => ev as { type: string; recoverable: boolean; error: Error });

/** Built as the SDK's console runner builds one; see fallback-primary-session.test.ts. */
function fakeJobContext(): JobContext {
  return new JobContext(
    {} as any,
    {
      job: { id: "AJ_test", room: { name: "room", sid: "RM_test" }, attributes: {} },
      url: "ws://localhost:7880",
      token: "",
      workerId: "W_test",
      fakeJob: true,
    } as any,
    new EventEmitter() as any,
    () => {},
    () => {},
    {} as any,
  );
}

/** An AgentSession as runAgentWorker builds it, on the OpenAI row, with provider-ended armed. */
function callSession(baseURL: string) {
  process.env.OPENAI_BASE_URL = baseURL;
  const { session } = createVoiceModelAndSession({
    voiceMode: "realtime",
    modelName: "livekit:openai/gpt-realtime",
    agent: { prompt: "You are a test agent.", options: {} } as any,
    call: { id: "call-1" } as any,
    tools: {} as any,
  });
  const seen = { errors: [] as voice.ErrorEvent[], closes: [] as voice.CloseEvent[], callsEnded: 0 };
  session.on(voice.AgentSessionEventTypes.Error, (ev) => seen.errors.push(ev));
  session.on(voice.AgentSessionEventTypes.Close, (ev) => seen.closes.push(ev));
  const teardown = createProviderEndedTeardown({
    currentSession: () => session,
    isCleaningUp: () => false,
    handoverInProgress: () => false,
    isBridged: () => false,
    consultInProgress: () => false,
    endCall: async () => {
      seen.callsEnded += 1;
    },
  });
  assert.equal(teardown.arm(session, { callId: "call-1", modelName: "livekit:openai/gpt-realtime" }), true);
  return { session, seen };
}

test("the plugin's own session still ends the process on a refused connect", () => {
  // If this starts failing after a plugin upgrade, the fix may be upstream: see openai-realtime.ts.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { initializeLogger } from "@livekit/agents";
       import * as openai from "@livekit/agents-plugin-openai";
       initializeLogger({ pretty: false, level: "fatal" });
       new openai.realtime.RealtimeModel({ apiKey: "sk-test", baseURL: ${JSON.stringify(refused)} })
         .session()
         .on("error", () => process.exit(3));
       setTimeout(() => process.exit(0), 3000);`,
    ],
    { cwd: LIVEKIT_DIR, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /Unhandled 'error' event/);
  assert.match(child.stderr, /ECONNREFUSED/);
});

const failures: Array<[string, () => string, number, RegExp]> = [
  ["a refused connect", () => refused, 10_000, /connection failed: connect ECONNREFUSED/],
  ["a 401 reply to the upgrade", () => server.baseURL("401"), 10_000, /Unexpected server response: 401/],
  ["a 429 reply to the upgrade", () => server.baseURL("429"), 10_000, /Unexpected server response: 429/],
  ["no reply within connOptions.timeoutMs", () => server.baseURL("hang"), 200, /connection timed out/],
];
for (const [name, baseURL, timeoutMs, message] of failures) {
  test(`${name} is an unrecoverable realtime_model_error on the session`, async () => {
    const session = model(baseURL(), timeoutMs).session();
    try {
      const ev = await firstError(session);
      assert.equal(ev.type, "realtime_model_error");
      assert.equal(ev.recoverable, false);
      assert.match(ev.error.message, message);
    } finally {
      await session.close();
    }
  });
}

test("the connect timeout defaults to 10 s", () => {
  assert.equal(new OpenAIRealtimeModel({ apiKey: "sk-test" })._options.connOptions.timeoutMs, 10_000);
});

test("an accepted connect reports no error and carries the session's events", async () => {
  const session = model(server.baseURL("ok")).session();
  const errors: unknown[] = [];
  session.on("error", (ev) => errors.push(ev));
  try {
    // The plugin queues a session.update when the session is made.
    await server.nextMessage();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(errors, []);
  } finally {
    await session.close();
  }
});

test("a connect that fails after start() closes the AgentSession with reason error and ends the call", async () => {
  await runWithJobContextAsync(fakeJobContext(), async () => {
    const { session, seen } = callSession(server.baseURL("held"));
    const upgrade = server.nextHeld();
    await session.start({ agent: new voice.Agent({ instructions: "test" }), record: false });
    // Not events.once(): it rejects on the "error" event that comes first.
    const closed = new Promise<voice.CloseEvent>((resolve) =>
      session.once(voice.AgentSessionEventTypes.Close, resolve),
    );
    (await upgrade).answer(429);
    assert.equal((await closed).reason, voice.CloseReason.ERROR);
    assert.equal(seen.errors.length, 1);
    assert.equal(seen.callsEnded, 1);

    // The runtime logs the event whole; its source is the model.
    const logged = JSON.parse(JSON.stringify(seen.errors[0]));
    assert.deepEqual(logged.source, {
      label: "openai.RealtimeModel",
      model: "gpt-realtime",
      provider: new URL(server.baseURL("held")).host,
    });
    assert.doesNotMatch(JSON.stringify(logged), /sk-test/);
  });
});

test("a connect that fails inside start(): agents-js emits no Close, provider-ended still ends the call", async () => {
  await runWithJobContextAsync(fakeJobContext(), async () => {
    const { session, seen } = callSession(refused);
    // With a chat history start() waits up to 5 s for the item acks, so the refused connect lands inside it.
    const chatCtx = llm.ChatContext.empty();
    chatCtx.addMessage({ role: "user", content: "hello" });
    await session.start({ agent: new voice.Agent({ instructions: "test", chatCtx }), record: false });
    assert.equal(seen.errors.length, 1);
    assert.equal(seen.callsEnded, 1);
    // Waits for the close agents-js began when the error arrived.
    await session.close();
    assert.deepEqual(seen.closes, [], "agents-js now reports this close: the Close handler covers it too");
    // start() arms the 15 s user-away timer after that close cancelled it, and close() now
    // returns early. Without this the test process waits the timer out.
    (session as any)._cancelUserAwayTimer?.();
  });
});

test("a consult session on the caller's model never ends the call", async () => {
  const shared = model(server.baseURL("held"));
  let callsEnded = 0;
  const call = { llm: shared };
  createProviderEndedTeardown({
    currentSession: () => call,
    isCleaningUp: () => false,
    handoverInProgress: () => false,
    isBridged: () => false,
    consultInProgress: () => false,
    endCall: async () => {
      callsEnded += 1;
    },
  }).arm(call, { callId: "call-1", modelName: "livekit:openai/gpt-realtime" });

  const callerRt = shared.session();
  const callerUpgrade = await server.nextHeld();
  // transfer-handler builds the consult AgentSession on the caller's model.
  const consultRt = shared.session();
  const consultUpgrade = await server.nextHeld();
  try {
    consultUpgrade.answer(429);
    await firstError(consultRt);
    assert.equal(callsEnded, 0);

    callerUpgrade.answer(429);
    await firstError(callerRt);
    assert.equal(callsEnded, 1);
  } finally {
    await Promise.all([consultRt.close(), callerRt.close()]);
  }
});
