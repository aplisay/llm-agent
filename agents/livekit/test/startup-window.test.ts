import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import {
  initializeLogger,
  JobContext,
  llm,
  runWithJobContextAsync,
  voice,
} from "@livekit/agents";
import { dispose } from "@livekit/rtc-node";
import { RealtimeModel } from "../plugins/ultravox/src/realtime/realtime_model.js";
import {
  StartupWindow,
  startFailureFromError,
  watchStartup,
} from "../lib/startup-window.js";

// The start-up window decides which failures go to options.fallback
// (docs/agent-failover.md): those before the agent first speaks, within 15 s.
// run: npx tsx --test test/startup-window.test.ts

initializeLogger({ pretty: false, level: "fatal" });
after(() => dispose());

const settledState = async (window: StartupWindow) => {
  try {
    await window.settled;
    return "closed";
  } catch (e) {
    return `failed: ${(e as Error).message}`;
  }
};

test("fail() while open records the failure and rejects both promises", async () => {
  const window = new StartupWindow();
  const error = new Error("refused");
  assert.equal(window.fail(error), true);
  assert.equal(window.open, false);
  assert.equal(window.failure, error);
  await assert.rejects(window.failed, /refused/);
  assert.equal(await settledState(window), "failed: refused");
  assert.throws(() => window.throwIfFailed(), /refused/);

  assert.equal(window.fail(new Error("later")), false, "the first failure wins");
  window.close();
  assert.equal(window.failure, error);
});

test("once closed, a failure is not a start failure", async () => {
  const window = new StartupWindow();
  window.close();
  assert.equal(window.open, false);
  assert.equal(await settledState(window), "closed");
  assert.equal(window.fail(new Error("too late")), false);
  assert.equal(window.failure, null);
  window.throwIfFailed();
});

test("the cap closes the window", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const window = new StartupWindow(15_000);
    mock.timers.tick(14_999);
    assert.equal(window.open, true);
    mock.timers.tick(1);
    assert.equal(window.open, false);
    assert.equal(await settledState(window), "closed");
    assert.equal(window.fail(new Error("after the cap")), false);
  } finally {
    mock.timers.reset();
  }
});

test("startFailureFromError: recoverable errors are not start failures", () => {
  const inner = new Error("provider refused");
  const ev = (error: unknown) => ({ type: "error", error, createdAt: 0 }) as voice.ErrorEvent;
  assert.equal(
    startFailureFromError(ev({ type: "realtime_model_error", error: inner, recoverable: true })),
    null,
  );
  assert.equal(
    startFailureFromError(ev({ type: "realtime_model_error", error: inner, recoverable: false })),
    inner,
  );
  assert.equal(
    startFailureFromError(ev({ type: "tts_error", error: inner, recoverable: false })),
    inner,
  );
  const selfError = Object.assign(new Error("interruption model down"), { recoverable: false });
  assert.equal(startFailureFromError(ev(selfError)), selfError);
  assert.match(startFailureFromError(ev(undefined))!.message, /start-up/);
});

function fakeJobContext(): JobContext {
  return new JobContext(
    {} as any,
    {
      job: { id: "AJ_window", room: { name: "room", sid: "RM_window" }, attributes: {} },
      url: "ws://localhost:7880",
      token: "",
      workerId: "W_window",
      fakeJob: true,
    } as any,
    new EventEmitter() as any,
    () => {},
    () => {},
    {} as any,
  );
}

/** Answers Ultravox POST /calls with 503 after `delayMs`. */
async function refusingUltravox(delayMs: number) {
  const server = http.createServer((_req, res) =>
    setTimeout(() => {
      res.writeHead(503);
      res.end("unavailable");
    }, delayMs),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  return { baseURL: `http://127.0.0.1:${port}/api/`, close: () => server.close() };
}

const ultravoxAgent = (baseURL: string) =>
  new voice.Agent({
    instructions: "test",
    // With a tool the plugin creates the Ultravox call as the session starts.
    llm: new RealtimeModel({ instructions: "test", apiKey: "test-key", baseURL } as any),
    tools: { hangup: llm.tool({ description: "hang up", execute: async () => "ok" }) },
  });

test("an Ultravox refusal lands after session.start() resolves and fails the window", async () => {
  const ultravox = await refusingUltravox(100);
  try {
    await runWithJobContextAsync(fakeJobContext(), async () => {
      const session = new voice.AgentSession({});
      const window = new StartupWindow();
      watchStartup(session, window);
      const closes: string[] = [];
      session.on(voice.AgentSessionEventTypes.Close, (ev) => closes.push(String(ev.reason)));

      await session.start({ agent: ultravoxAgent(ultravox.baseURL), record: false });
      assert.equal(window.open, true, "start() does not wait for the Ultravox call");

      assert.match(await settledState(window), /^failed: Failed to create Ultravox call: 503/);
      // The SDK closes a session on an unrecoverable model error.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(closes, [voice.CloseReason.ERROR]);
    });
  } finally {
    ultravox.close();
  }
});

test("after the agent has spoken, a model failure no longer fails the window", async () => {
  const ultravox = await refusingUltravox(300);
  try {
    await runWithJobContextAsync(fakeJobContext(), async () => {
      const session = new voice.AgentSession({});
      const window = new StartupWindow();
      watchStartup(session, window);
      const closes: string[] = [];
      session.on(voice.AgentSessionEventTypes.Close, (ev) => closes.push(String(ev.reason)));

      await session.start({ agent: ultravoxAgent(ultravox.baseURL), record: false });
      (session as unknown as { _updateAgentState(s: string): void })._updateAgentState("speaking");
      assert.equal(await settledState(window), "closed");

      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(closes, [voice.CloseReason.ERROR], "the SDK still closed the session");
      assert.equal(window.failure, null);
    });
  } finally {
    ultravox.close();
  }
});

test("a recoverable error during start-up does not fail the window", async () => {
  await runWithJobContextAsync(fakeJobContext(), async () => {
    const session = new voice.AgentSession({});
    const window = new StartupWindow();
    watchStartup(session, window);
    session.emit(
      voice.AgentSessionEventTypes.Error,
      voice.createErrorEvent({
        type: "realtime_model_error",
        timestamp: Date.now(),
        label: "test",
        error: new Error("retrying"),
        recoverable: true,
      }),
    );
    assert.equal(window.open, true);
    window.close();
  });
});
