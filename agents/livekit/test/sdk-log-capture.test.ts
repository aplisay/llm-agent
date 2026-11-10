import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import pino from "pino";

// agents-js and plugin lines in the call's invocation log: captureSdkLogs adds a stream to the
// SDK's pino multistream, so stdout still gets every line and the buffer gets a redacted copy.
// run: npx tsx --test test/sdk-log-capture.test.ts

const SECRET = "sdk-capture-standin-5e1d0c9b7a3f";
// Set before the logger loads: it reads secret env values to mask them.
process.env.SDK_CAPTURE_TEST_API_KEY = SECRET;

const { initializeLogger, log } = await import("@livekit/agents");
const { invocationLogTime } = await import("../lib/invocation-log-buffer.js");
const { captureSdkLogs, getCaptureStats, setInvocationLogBuffer } = await import("../lib/logger.js");

const OTEL_LOGS_ENABLED = Symbol.for("@livekit/agents:otelEnabled");

initializeLogger({ pretty: false, level: "debug" });

type Line = Record<string, unknown>;

function freshBuffer(): Line[] {
  const buf: Line[] = [];
  setInvocationLogBuffer(buf);
  return buf;
}

/** Runs fn with process.stdout.write swapped out, so the SDK's stdout lines can be counted. */
function stdoutDuring(fn: () => void): string[] {
  const lines: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = write;
  }
  return lines;
}

// The job process logs through a child made at startJobRequest, before the entry runs.
const jobLogger = log().child({ jobID: "AJ_test", room_id: "RM_test" });

test("captureSdkLogs copies info and above from the SDK logger and its children", () => {
  assert.equal(captureSdkLogs(log()), true);
  const buf = freshBuffer();
  const before = getCaptureStats() as { sdk: number };

  const stdout = stdoutDuring(() => {
    log().info({ ultravoxCallId: "uv-1" }, "Created Ultravox call");
    jobLogger.warn("WebSocket not ready, buffering audio frame");
    jobLogger.child({ speech_id: "speech_1" }).info("Creating speech handle");
    jobLogger.debug("job started");
  });

  assert.deepEqual(
    buf.map((l) => l.msg),
    ["Created Ultravox call", "WebSocket not ready, buffering audio frame", "Creating speech handle"],
  );
  assert.equal(buf[0].ultravoxCallId, "uv-1");
  assert.equal(buf[1].jobID, "AJ_test");
  assert.equal(buf[1].level, 40);
  assert.equal(buf[2].speech_id, "speech_1");
  assert.equal(typeof buf[2].time, "number");
  assert.equal((getCaptureStats() as { sdk: number }).sdk - before.sdk, 3);
  assert.equal(stdout.length, 4, "stdout still gets every line, debug included");
});

test("captureSdkLogs adds its stream once", () => {
  assert.equal(captureSdkLogs(jobLogger), true);
  assert.equal(captureSdkLogs(log()), true);
  const buf = freshBuffer();
  stdoutDuring(() => jobLogger.info("closing call"));
  assert.equal(buf.length, 1);
});

test("captured SDK lines are masked like our own", () => {
  const buf = freshBuffer();
  stdoutDuring(() => jobLogger.info({ apiKey: "plain-value-1234567", note: `uses ${SECRET}` }, "plugin options"));
  assert.equal(buf.length, 1);
  assert.equal(buf[0].apiKey, "[Redacted]");
  assert.equal(JSON.stringify(buf[0]).includes(SECRET), false);
});

test("captureSdkLogs leaves lines to the exporter while LiveKit Cloud log export is on", () => {
  const buf = freshBuffer();
  const globals = globalThis as Record<symbol, unknown>;
  globals[OTEL_LOGS_ENABLED] = true;
  try {
    stdoutDuring(() => jobLogger.info("exported line"));
  } finally {
    delete globals[OTEL_LOGS_ENABLED];
  }
  stdoutDuring(() => jobLogger.info("buffered line"));
  assert.deepEqual(buf.map((l) => l.msg), ["buffered line"]);
});

test("captureSdkLogs returns false for a logger with one plain destination", () => {
  const sink = new Writable({ write: (_chunk, _enc, done) => done() });
  assert.equal(captureSdkLogs(pino({ level: "info" }, sink)), false);
});

test("invocationLogTime reads the GCP timestamp and pino time, so mixed lines sort together", () => {
  const ours = (s: number, ms: number) => ({ timestamp: { seconds: s, nanos: ms * 1e6 } });
  assert.equal(invocationLogTime(ours(1792754684, 931)), 1792754684931);
  assert.equal(invocationLogTime({ time: 1792754684951 }), 1792754684951);
  assert.equal(invocationLogTime({ time: "2026-10-23T11:24:44.002Z" }), Date.parse("2026-10-23T11:24:44.002Z"));
  assert.equal(invocationLogTime({}), 0);
  assert.equal(invocationLogTime(null), 0);

  const lines = [
    { message: "session started", ...ours(1792754685, 43) },
    { msg: "Creating Ultravox call", time: 1792754684951 },
    { message: "Connected to LiveKit", ...ours(1792754684, 901) },
  ];
  const sorted = [...lines].sort((a, b) => invocationLogTime(a) - invocationLogTime(b));
  assert.deepEqual(
    sorted.map((l) => ("message" in l ? l.message : l.msg)),
    ["Connected to LiveKit", "Creating Ultravox call", "session started"],
  );
});
