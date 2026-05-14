import { setInvocationLogBuffer } from "./logger.js";

/** Buffered telemetry logs persisted as InvocationLog at job shutdown. */
export const invocationLogs: unknown[] = [];
setInvocationLogBuffer(invocationLogs);
