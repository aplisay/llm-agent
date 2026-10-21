import fs from "node:fs";
import path from "node:path";

export type GoogleCredentialResult =
  | { status: "unset" | "no-source" | "present"; path?: string }
  | { status: "written"; path: string; bytes: number }
  | { status: "failed"; path: string; error: string };

/**
 * Write GOOGLE_CREDENTIAL to the file GOOGLE_APPLICATION_CREDENTIALS names, for
 * ADC clients such as the GCS recording upload. The agent does this itself, not
 * entrypoint.sh, because a deployment that overrides the entrypoint skipped it
 * and lost every recording. Never throws, and leaves an existing file alone.
 */
export function writeGoogleCredential(
  env: NodeJS.ProcessEnv = process.env,
): GoogleCredentialResult {
  const target = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!target) return { status: "unset" };
  // GOOGLE_APPLICATION_CREDENTIALS_JSON is the inline form pipecat also takes.
  const content = env.GOOGLE_CREDENTIAL || env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!content) return { status: "no-source", path: target };
  if (fs.existsSync(target)) return { status: "present", path: target };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    return { status: "failed", path: target, error: (err as Error).message };
  }
  try {
    // 'wx' so a job process racing the supervisor cannot clobber a finished write.
    fs.writeFileSync(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { status: "written", path: target, bytes: content.length };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { status: "present", path: target };
    }
    return { status: "failed", path: target, error: (err as Error).message };
  }
}
