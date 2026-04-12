import pino from "pino";
import { createGcpLoggingPinoConfig } from "@google-cloud/pino-logging-gcp-config";

const captureStats = {
  parsed: 0,
  parseErrors: 0,
};

const isProdLike =
  process.env.NODE_ENV === "production" || process.env.NODE_ENV === "staging";

const gcpConfig = createGcpLoggingPinoConfig(
  {},
  {
    level: process.env.LOGLEVEL || "info",
  },
);

const destination = isProdLike ? undefined : pino.transport({
  target: "pino-pretty",
  options: { colorize: true },
});

const hooks = {
  streamWrite(s) {
    if (logBuffer) {
      try {
        logBuffer.push(JSON.parse(s)) && captureStats.parsed++;
      } catch (e) {
        console.error("Error parsing log: ", e);
        captureStats.parseErrors++;
      }
    }
    return s
  },
};


const logOptions: pino.LoggerOptions = {
  name: "livekit-agent-userland",
  level: process.env.LOGLEVEL || (isProdLike ? "info" : "debug"),
  depthLimit: 5,
  ...(isProdLike ? gcpConfig : {}),
  hooks,
};

const logger = pino(logOptions, destination);

let logBuffer: unknown[] | null = null;

export function setInvocationLogBuffer(_buf: unknown[]): void {
  logBuffer = _buf;
}

export function getCaptureStats(): {

} {
  return {
    ...captureStats,
    lines: logBuffer?.length
      };
}

export default logger;
