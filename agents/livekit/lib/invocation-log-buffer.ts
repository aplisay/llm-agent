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
