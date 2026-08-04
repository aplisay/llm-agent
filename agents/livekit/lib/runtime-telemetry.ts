/**
 * Periodic runtime sampling: event-loop delay, CPU and memory, per process.
 *
 * This exists to answer the one question a CPU graph cannot. When a node
 * thread sits at 100%, either:
 *
 *   - the JS main thread is genuinely saturated, in which case event-loop
 *     delay climbs in step with CPU — the cause is our code, or something we
 *     call synchronously; or
 *   - the busy thread is not the JS main thread at all (a libuv threadpool
 *     thread doing sync fs/crypto/zlib/dns, a V8 GC or JIT helper, or one of
 *     rtc-node's Rust/tokio threads), in which case CPU is high while
 *     `loopP99Ms` stays flat.
 *
 * Those two need completely different investigations, and telling them apart
 * from the outside needs a profiler attached at the right moment. This tells
 * them apart from a log line, on any call, with nothing attached.
 *
 * Off unless RUNTIME_STATS_MS is set to a positive number of milliseconds.
 * 30000 is a sensible always-on value: one line per process per 30s, which is
 * ~22 lines/minute at NUM_IDLE_PROCESSES=10.
 *
 * realtime.ts is evaluated in the supervisor AND in every spawned job process,
 * so this runs in both. Each line carries role/pid/ppid so it can be lined up
 * with `docker exec <c> ps -ef --forest`.
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
            // What is keeping this process's event loop alive, by handle type.
            //
            // Roughly a third of job processes finish their call and then never
            // exit (120 `new call` vs 83 `job exiting` over one container's
            // life, 15 alive under a pool configured for 3, oldest 16 hours).
            // The pool still counts them as busy, so drain() waits on join()
            // for them and never sends a SIGTERM — which is why every stop runs
            // out the 300s grace period and gets force-killed.
            //
            // A leaked process reports this every interval, so whatever handle
            // is holding it open shows up without having to catch one live.
            // Counted by type rather than listed, to keep the line bounded.
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
