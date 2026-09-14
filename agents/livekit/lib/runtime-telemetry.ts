/**
 * Sample event-loop delay alongside CPU to distinguish main-thread stalls from native-thread activity.
 * See agents/livekit/deploy/gcp/README.md for RUNTIME_STATS_MS.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import logger from "./logger.js";

/**
 * Job processes are forked with an IPC channel and so have `process.send`;
 * the supervisor is spawned by the entrypoint and does not. The SDK's separate
 * inference process would also report "job", but nothing registers an
 * inference runner in this build, so it is never started.
 */
function processRole(): "supervisor" | "job" {
  return typeof process.send === "function" ? "job" : "supervisor";
}

/**
 * `{ Timeout: 3, TCPSocketWrap: 2 }` — the handles currently keeping the event
 * loop alive, tallied by type. Node returns a flat list of type names, which is
 * unbounded and mostly repetition; the counts are what identify a leak.
 */
function activeResourceCounts(): Record<string, number> | undefined {
  const info = process.getActiveResourcesInfo?.();
  if (!info) return undefined;
  const counts: Record<string, number> = {};
  for (const kind of info) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

let started = false;

export function startRuntimeTelemetry(): void {
  if (started) return;

  const intervalMs = Number.parseInt(process.env.RUNTIME_STATS_MS ?? "0", 10);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

  try {
    // resolution is the sampling period of the delay histogram itself; 20ms is
    // fine-grained enough to see a blocked loop and cheap enough to leave on.
    const RESOLUTION_MS = 20;
    const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    histogram.enable();

    const role = processRole();
    let lastCpu = process.cpuUsage();
    let lastAt = process.hrtime.bigint();

    const timer = setInterval(() => {
      try {
        const now = process.hrtime.bigint();
        const cpu = process.cpuUsage(lastCpu);
        const elapsedUs = Number(now - lastAt) / 1000;
        lastCpu = process.cpuUsage();
        lastAt = now;

        const mem = process.memoryUsage();
        // The histogram reports the interval between successive timer fires,
        // which at idle is the resolution itself — reporting that raw makes a
        // healthy loop look like a 21ms delay. Subtract it so these read as
        // excess delay, i.e. ~0 when the loop is keeping up.
        const ms = (ns: number) =>
          Math.max(0, Math.round((ns / 1e6 - RESOLUTION_MS) * 100) / 100);

        logger.info(
          {
            role,
            pid: process.pid,
            ppid: process.ppid,
            uptimeS: Math.round(process.uptime()),
            // If these climb while CPU is pegged, the JS main thread is the
            // thing that is busy.
            loopP50Ms: ms(histogram.percentile(50)),
            loopP99Ms: ms(histogram.percentile(99)),
            loopMaxMs: ms(histogram.max),
            // Percent of ONE core over the sampling window, so it lines up
            // with `top -H` rather than with the GCE console's normalised graph.
            cpuPct: Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10,
            cpuUserMs: Math.round(cpu.user / 1000),
            cpuSysMs: Math.round(cpu.system / 1000),
            rssMb: Math.round(mem.rss / 1e6),
            heapUsedMb: Math.round(mem.heapUsed / 1e6),
            // Count active resources by type to identify handles preventing job-process exit without unbounded log output. See PR
            // #205.
            activeResources: activeResourceCounts(),
          },
          "runtime stats",
        );
        histogram.reset();
      } catch (e) {
        // Telemetry must never be able to take the worker down.
        logger.warn({ e }, "runtime stats sample failed");
      }
    }, intervalMs);

    // unref so a job process that has finished its work is never held open by
    // the sampler.
    timer.unref();
    started = true;

    logger.info(
      { role, pid: process.pid, intervalMs },
      "runtime telemetry enabled",
    );
  } catch (e) {
    logger.warn({ e }, "could not start runtime telemetry");
  }
}

export default startRuntimeTelemetry;
