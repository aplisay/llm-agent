import { setInvocationLogBuffer } from "./logger.js";

/** Buffered telemetry logs persisted as InvocationLog at job shutdown. */
export const invocationLogs: unknown[] = [];
setInvocationLogBuffer(invocationLogs);

/**
 * An entry's time in ms: pino's `time` (agents-js lines) or the GCP `timestamp` our own logger
 * writes in production. 0 when it has neither.
 */
export function invocationLogTime(entry: unknown): number {
  const { time, timestamp } = (entry ?? {}) as {
    time?: number | string;
    timestamp?: { seconds?: number; nanos?: number };
  };
  if (typeof time === "number") return time;
  if (typeof time === "string") return new Date(time).getTime();
  if (typeof timestamp?.seconds === "number") return timestamp.seconds * 1000 + (timestamp.nanos ?? 0) / 1e6;
  return 0;
}

/** "runtime stats" or "runtime stats sample failed". GCP-formatted lines use `message`, others `msg`. */
function isRuntimeStats(line: unknown): boolean {
  const l = line as { msg?: unknown; message?: unknown } | null;
  const text = l?.msg ?? l?.message;
  return typeof text === "string" && text.startsWith("runtime stats");
}

/**
 * Call at job start. The buffer fills from process start, so a pre-warmed job process that waits
 * hours for a call holds one runtime stats line per sample, enough to pass the API's 512 KB
 * invocation log cap before the call logs anything. Keeps the setup lines and the latest sample.
 * Returns how many lines were dropped.
 */
export function trimIdleLines(): number {
  let latest = -1;
  for (let i = invocationLogs.length - 1; i >= 0; i--) {
    if (isRuntimeStats(invocationLogs[i])) {
      latest = i;
      break;
    }
  }
  // In place: the logger and the shutdown callback hold this same array.
  let kept = 0;
  for (let i = 0; i < invocationLogs.length; i++) {
    const line = invocationLogs[i];
    if (i === latest || !isRuntimeStats(line)) invocationLogs[kept++] = line;
  }
  const dropped = invocationLogs.length - kept;
  invocationLogs.length = kept;
  return dropped;
}
