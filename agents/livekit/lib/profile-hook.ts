/**
 * V8 CPU profile hook, loaded with `node --import` so that it runs BEFORE the
 * agent's module graph is evaluated.
 *
 *   NODE_OPTIONS=--import /usr/src/app/dist/lib/profile-hook.js
 *   PROFILE_MS=90000
 *
 * The `--import` placement is the point. `--cpu-prof` is rejected inside
 * NODE_OPTIONS, and anything started from realtime.ts is already too late:
 * ESM imports are hoisted, so `lib/worker.js` and its dependency graph
 * (sequelize, pg, @google-cloud/*, five livekit plugins, rtc-node's native
 * module) have all been evaluated and JIT-compiled before the first statement
 * of realtime.ts runs. A profile that starts here sees that work; one started
 * from inside the app never can.
 *
 * That matters because the pool keeps NUM_IDLE_PROCESSES spare job processes
 * and forks a replacement every time one is consumed, so module load is paid
 * per call, not just at boot.
 *
 * Env:
 *   PROFILE_MS           window in ms to profile from process start, then
 *                        write and stop. 0/unset = do not auto-profile.
 *   PROFILE_SIGNAL       "1" installs a SIGUSR2 toggle for ad-hoc capture.
 *                        Off by default because nodemon uses SIGUSR2 to
 *                        restart, which would make `yarn develop` unusable.
 *   PROFILE_DIR          output directory (default /prof).
 *   PROFILE_INTERVAL_US  V8 sampling interval (default 1000, V8's own
 *                        default). 200 gives more detail at more overhead.
 *
 * With neither PROFILE_MS nor PROFILE_SIGNAL set the hook attaches nothing and
 * costs one module load, so the --import can be left in place permanently and
 * profiling toggled with PROFILE_MS alone.
 *
 * Nothing here writes to stdout. entrypoint.sh runs `eval $(node
 * load-secretenv.js)`, so a stray stdout line from a hook applied to that
 * process would be eval'd by the shell; this hook both restricts itself to
 * stderr and declines to attach to that process at all.
 */
import { Session } from "node:inspector";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const note = (message: string): void => {
  process.stderr.write(`[profile-hook] ${message}\n`);
};

const intEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const mainScript = basename(process.argv[1] ?? "");
const windowMs = intEnv("PROFILE_MS", 0);
const signalEnabled = process.env.PROFILE_SIGNAL === "1";
const outputDir = process.env.PROFILE_DIR || "/prof";
const samplingIntervalUs = intEnv("PROFILE_INTERVAL_US", 1000);

// Never attach to the secretenv loader: its stdout is shell input.
const inert = mainScript === "load-secretenv.js" || (windowMs <= 0 && !signalEnabled);

if (!inert) {
  const role = typeof process.send === "function" ? "job" : "supervisor";
  const session = new Session();
  let running = false;

  const start = (): void => {
    if (running) return;
    running = true;
    session.post("Profiler.enable", () => {
      session.post(
        "Profiler.setSamplingInterval",
        { interval: samplingIntervalUs },
        () => {
          session.post("Profiler.start", (err) => {
            if (err) {
              running = false;
              note(`could not start: ${err.message}`);
              return;
            }
            note(`profiling ${role} pid=${process.pid} (${mainScript})`);
          });
        },
      );
    });
  };

  const stop = (reason: string): void => {
    if (!running) return;
    running = false;
    session.post("Profiler.stop", (err, result) => {
      if (err) {
        note(`could not stop: ${err.message}`);
        return;
      }
      try {
        mkdirSync(outputDir, { recursive: true });
        // Named so a directory full of these can be told apart: which role,
        // which pid, when. Chrome DevTools (Performance -> Load profile) and
        // speedscope both open .cpuprofile directly.
        const file = join(
          outputDir,
          `cpu-${role}-${process.pid}-${Date.now()}.cpuprofile`,
        );
        writeFileSync(file, JSON.stringify(result.profile));
        note(`wrote ${file} (${reason})`);
      } catch (e) {
        note(`could not write profile: ${String(e)}`);
      }
    });
  };

  try {
    session.connect();
    start();

    if (windowMs > 0) {
      // unref: a spare job process that exits before the window closes must
      // not be held open by this timer. Such a process writes no profile,
      // which is the correct outcome — it did nothing worth looking at.
      setTimeout(() => stop(`${windowMs}ms window elapsed`), windowMs).unref();
    }

    if (signalEnabled) {
      // Deliberately no SIGTERM handler: adding a listener suppresses Node's
      // default termination, and getting that wrong would stall shutdown of
      // every job process. Use a bounded PROFILE_MS window, or SIGUSR2.
      process.on("SIGUSR2", () => {
        if (running) stop("SIGUSR2");
        else start();
      });
      note(`SIGUSR2 toggle armed on pid=${process.pid}`);
    }
  } catch (e) {
    note(`disabled: ${String(e)}`);
  }
}
