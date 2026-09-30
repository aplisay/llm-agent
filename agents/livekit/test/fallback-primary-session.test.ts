import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  initializeLogger,
  JobContext,
  runWithJobContextAsync,
  voice,
} from "@livekit/agents";
import { releaseFailedAttemptSession } from "../lib/primary-session.js";

// A fallback retry (worker.ts fallbackLoop) starts a second recorded AgentSession in the same
// job. Offline: a real JobContext for a fake job, built as the SDK's console runner builds one,
// and real sessions with no models or room.
// run: npx tsx --test test/fallback-primary-session.test.ts

initializeLogger({ pretty: false, level: "fatal" });

const PRIMARY_REFUSED = /Only one `AgentSession` can be the primary at a time/;

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

/** Started as runAgentWorker starts it when recording is on. */
const startRecorded = (session: voice.AgentSession) =>
  session.start({ agent: new voice.Agent({ instructions: "test" }), record: true });

const onClose = (session: voice.AgentSession) => {
  const state = { closed: false };
  session.on(voice.AgentSessionEventTypes.Close, () => (state.closed = true));
  return state;
};

test("agents-js keeps a closed session as primary and refuses a recorded retry", async () => {
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    const failed = new voice.AgentSession({});
    await startRecorded(failed);
    await failed.close();
    assert.ok(ctx._primaryAgentSession === failed);

    await assert.rejects(startRecorded(new voice.AgentSession({})), PRIMARY_REFUSED);
  });
});

test("after release the retry is the primary, records, and is closed and reported at job end", async () => {
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    const failed = new voice.AgentSession({});
    await startRecorded(failed);
    const failedState = onClose(failed);

    await releaseFailedAttemptSession(ctx, failed);
    assert.equal(failedState.closed, true);
    assert.equal(ctx._primaryAgentSession, undefined);

    const retry = new voice.AgentSession({});
    await startRecorded(retry);
    assert.ok(ctx._primaryAgentSession === retry);
    assert.equal(retry.sessionOptions.recordingOptions.audio, true);

    // The SDK's job end (finalizeSession): close the primary, then report on it.
    const retryState = onClose(retry);
    const reported: unknown[] = [];
    const makeSessionReport = ctx.makeSessionReport.bind(ctx);
    ctx.makeSessionReport = (session) => {
      reported.push(session);
      return makeSessionReport(session);
    };
    await ctx._primaryAgentSession?.close();
    await ctx._onSessionEnd();
    assert.equal(retryState.closed, true);
    assert.equal(reported.length, 1);
    assert.ok(reported[0] === retry);
  });
});

test("releasing a session that never started, or none, lets the retry take the primary", async () => {
  // The usual failure today: model setup or call.start() threw before session.start().
  const ctx = fakeJobContext();
  await runWithJobContextAsync(ctx, async () => {
    await releaseFailedAttemptSession(ctx, new voice.AgentSession({}));
    await releaseFailedAttemptSession(ctx, null);

    const retry = new voice.AgentSession({});
    await startRecorded(retry);
    assert.ok(ctx._primaryAgentSession === retry);
    await retry.close();
  });
});
