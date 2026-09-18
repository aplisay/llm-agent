/**
 * Observe exits without signal handlers or uncaughtException listeners, which suppress default termination. See PR
 * #205. Write synchronously to stderr because buffered logs may not flush during exit.
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
