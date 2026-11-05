import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Writable } from "node:stream";
import pino from "pino";
import { logOptions } from "../lib/logger.js";
import { invocationLogs, trimIdleLines } from "../lib/invocation-log-buffer.js";

// A pre-warmed job process logs one runtime stats line per RUNTIME_STATS_MS until it gets a call.
// Those lines must not fill the call's invocation log, but must still reach stdout.
// run: npx tsx --test test/invocation-log-idle-trim.test.ts

type Line = Record<string, any>;

/** The worker logger's options with a sink standing in for stdout. */
function workerLogger() {
  const written: string[] = [];
  const sink = new Writable({
    write: (chunk, _encoding, done) => {
      written.push(String(chunk));
      done();
    },
  });
  return { logger: pino({ ...logOptions, level: "info" }, sink), written };
}

const stats = (uptimeS: number) => ({
  role: "job",
  uptimeS,
  loopP50Ms: 0,
  loopP99Ms: 0.4,
  cpuPct: 0.1,
  rssMb: 180,
  activeResources: { Timeout: 3, TCPSocketWrap: 2 },
});

beforeEach(() => {
  invocationLogs.length = 0;
});

test("job start drops an idle process's runtime stats but keeps the setup lines and the latest sample", async () => {
  const { logger, written } = workerLogger();
  logger.info({ role: "job", intervalMs: 30_000 }, "runtime telemetry enabled");
  logger.info({ role: "job" }, "exit forensics installed");
  // Ten hours at one sample per 30 s.
  const SAMPLES = 1200;
  for (let i = 1; i <= SAMPLES; i++) logger.info(stats(i * 30), "runtime stats");
  assert.equal(invocationLogs.length, SAMPLES + 2);

  assert.equal(trimIdleLines(), SAMPLES - 1);
  logger.info({ job: { id: "job-1" } }, "new call");
  logger.info("session started");
  logger.info(stats((SAMPLES + 1) * 30), "runtime stats");
  logger.info("call ended");

  const lines = invocationLogs as Line[];
  assert.deepEqual(
    lines.map((l) => l.msg),
    [
      "runtime telemetry enabled",
      "exit forensics installed",
      "runtime stats",
      "new call",
      "session started",
      "runtime stats",
      "call ended",
    ],
  );
  assert.equal(lines[2]!.uptimeS, SAMPLES * 30, "the kept sample is the latest one");

  await tick();
  const statsWritten = written.filter((s) => JSON.parse(s).msg === "runtime stats").length;
  assert.equal(statsWritten, SAMPLES + 1, "every sample still reaches stdout");
});

test("matches GCP-formatted lines and failed samples, and leaves a buffer with no samples alone", () => {
  // In production the GCP pino config names the message field `message`.
  invocationLogs.push(
    { message: "runtime telemetry enabled" },
    { message: "runtime stats", uptimeS: 30 },
    { message: "runtime stats sample failed" },
    { message: "runtime stats", uptimeS: 90 },
    { message: "worker idle" },
  );
  assert.equal(trimIdleLines(), 2);
  assert.deepEqual(invocationLogs, [
    { message: "runtime telemetry enabled" },
    { message: "runtime stats", uptimeS: 90 },
    { message: "worker idle" },
  ]);

  invocationLogs.length = 0;
  invocationLogs.push({ msg: "exit forensics installed" }, { msg: "new call" });
  assert.equal(trimIdleLines(), 0);
  assert.deepEqual(invocationLogs, [{ msg: "exit forensics installed" }, { msg: "new call" }]);
});
