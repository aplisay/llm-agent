/**
 * Load with --import to capture module startup; keep stdout clear because the secret loader shell-evaluates it.
 * See agents/livekit/deploy/gcp/README.md and PR #205 for profiling controls.
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
const onExit = process.env.PROFILE_ON_EXIT === "1";
const outputDir = process.env.PROFILE_DIR || "/prof";
const samplingIntervalUs = intEnv("PROFILE_INTERVAL_US", 1000);

// Job processes are forked with an IPC channel and so have `process.send`;
// the supervisor is started by the entrypoint and does not.
const role: "job" | "supervisor" =
  typeof process.send === "function" ? "job" : "supervisor";
const roleFilter = (process.env.PROFILE_ROLE || "all").toLowerCase();
const roleWanted = roleFilter === "all" || roleFilter === role;

// Never attach to the secretenv loader: its stdout is shell input.
const inert =
  mainScript === "load-secretenv.js" ||
  !roleWanted ||
  (windowMs <= 0 && !signalEnabled && !onExit);

if (!inert) {
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
      try {
        session.disconnect();
      } catch {
        /* already gone */
      }
    });
  };

  const stopAtEndOfJob = (): void => {
    const realSend = process.send?.bind(process);
    if (realSend) {
      process.send = ((msg: unknown, ...rest: unknown[]) => {
        const kind = (msg as { case?: string } | null)?.case;
        if (kind === "done" || kind === "exiting") stop(`job ${kind}`);
        return (realSend as (...a: unknown[]) => boolean)(msg, ...rest);
      }) as typeof process.send;
    }
    process.on("message", (msg: unknown) => {
      if ((msg as { case?: string } | null)?.case === "shutdownRequest") {
        stop("shutdownRequest");
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

    if (onExit) {
      // Primary: end the profile when the job ends. In a job process this is
      // what actually fires; the two handlers below are fallbacks.
      stopAtEndOfJob();

      // `Profiler.stop` on a local inspector session invokes its callback
      // before post() returns, so the whole stop-and-write is synchronous and
      // therefore legal inside an 'exit' handler. This is the path the
      // supervisor takes — it has no job IPC — and the backstop for a job
      // process that exits without either signal above.
      process.on("exit", () => stop("process exit"));

      // 'exit' does not fire when a signal terminates the process. The
      // supervisor is signalled on container stop, and a job process that
      // overruns the SDK's 5s closeTimeout is killed too, so catch that as
      // well. Adding a listener suppresses Node's default termination, so if
      // nothing else is listening we must terminate ourselves — in the worker
      // both the SDK and realtime.ts have registered handlers by the time this
      // fires, and realtime.ts's calls process.exit.
      process.on("SIGTERM", () => {
        stop("SIGTERM");
        if (process.listenerCount("SIGTERM") === 1) process.exit(143);
      });
    }

    if (signalEnabled) {
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
