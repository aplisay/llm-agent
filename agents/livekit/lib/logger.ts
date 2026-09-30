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

const SECRET_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD)$/i;
// Matched on the serialised line: pino's redact paths cannot name a field at any depth.
const SECRET_FIELD =
  /"([\w-]*(?:api[-_]?key|secret|password|token|authorization|private[-_]?key))":"(?:[^"\\]|\\.)+"/gi;
const REDACTED = "[Redacted]";

let secretValues: string[] = [];
let secretValuesAt = 0;

// Re-read at most once a second: secretenv fills the environment after this module loads.
function envSecretValues(): string[] {
  const now = Date.now();
  if (now - secretValuesAt >= 1000) {
    secretValuesAt = now;
    secretValues = Object.entries(process.env)
      .filter(([name, value]) => SECRET_ENV_NAME.test(name) && value && value.length >= 12)
      .map(([, value]) => JSON.stringify(value).slice(1, -1));
  }
  return secretValues;
}

/** Masks secret-named fields and the values of secret env vars in a serialised line. */
function redactLine(line: string): string {
  let out = line.replace(SECRET_FIELD, `"$1":"${REDACTED}"`);
  for (const value of envSecretValues()) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  return out;
}

const hooks = {
  streamWrite(s) {
    s = redactLine(s);
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


export const logOptions: pino.LoggerOptions = {
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
