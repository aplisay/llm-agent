/**
 * Why did this process exit?
 *
 * Staging showed the supervisor exiting with RestartCount=2, ExitCode=0, not
 * OOM-killed — i.e. a *clean* exit, which `restart: always` then papered over.
 * Nothing in the logs said who decided to stop.
 *
 * ExitCode=0 narrows it to exactly two causes, because a process killed by a
 * signal reports 128+N, never 0:
 *
 *   1. someone called process.exit() / process.exit(0)
 *   2. the event loop drained — the worker simply ran out of work and returned
 *
 * This distinguishes them, and for (1) names the caller. Deliberately no
 * signal listeners: adding a SIGTERM/SIGINT listener suppresses Node's default
 * termination, which is the precise bug that made every deploy hang for 300s
 * (see realtime.ts). Signals are already identifiable from the container exit
 * code, so there is nothing to gain and a repeat of that bug to lose.
 *
 * Likewise `uncaughtExceptionMonitor` rather than `uncaughtException`: the
 * monitor variant observes without suppressing the default crash. An
 * `uncaughtException` listener would silently convert crashes into hangs, and
 * unhandled rejections surface through the same monitor under Node's default
 * --unhandled-rejections=throw, so both are covered without changing
 * behaviour.
 *
 * The final lines are written with fs.writeSync to fd 2 rather than through
 * pino: at exit time pino's stream may never flush, and the whole point is to
 * still have the message in `docker logs` afterwards.
 */
import { writeSync } from "node:fs";
import logger from "./logger.js";

let installed = false;

/** Synchronous, unbuffered, JSON — survives process.exit(). */
function emit(fields: Record<string, unknown>): void {
  try {
    writeSync(
      2,
      JSON.stringify({ severity: "WARNING", exitForensics: true, ...fields }) + "\n",
    );
  } catch {
    /* never let diagnostics take the process down */
  }
}

export function installExitForensics(role: "supervisor" | "job"): void {
  if (installed) return;
  installed = true;

  const base = () => ({
    role,
    pid: process.pid,
    ppid: process.ppid,
    uptimeS: Math.round(process.uptime()),
  });

  // (1) Explicit exit. The stack is the whole point — it names the caller,
  // which is otherwise invisible. Note there IS a `setImmediate(() =>
  // process.exit(0))` in voice-agent-runtime.ts; if that ever runs in the
  // supervisor rather than a job process, this is what will show it.
  const realExit = process.exit.bind(process);
  process.exit = ((code?: number): never => {
    emit({
      ...base(),
      event: "process.exit() called",
      code: code ?? process.exitCode ?? 0,
      stack: new Error("process.exit").stack,
    });
    return realExit(code) as never;
  }) as typeof process.exit;

  // (2) Natural drain. beforeExit does NOT fire when process.exit() is used,
  // so seeing this instead of the above is itself the answer: nothing was
  // keeping the loop alive. The active-resource list says what was left.
  process.on("beforeExit", (code) => {
    emit({
      ...base(),
      event: "event loop drained — no work left",
      code,
      activeResources: process.getActiveResourcesInfo?.() ?? "unavailable",
    });
  });

  // Final word, whatever the route. Must stay synchronous.
  process.on("exit", (code) => {
    emit({ ...base(), event: "process exiting", code });
  });

  // Observe crashes without suppressing them.
  process.on("uncaughtExceptionMonitor", (err, origin) => {
    emit({
      ...base(),
      event: "uncaughtException (process will terminate)",
      origin,
      message: err?.message,
      stack: err?.stack,
    });
  });

  logger.info({ role, pid: process.pid }, "exit forensics installed");
}

export default installExitForensics;
