import fs from 'node:fs';
import path from 'node:path';

/**
 * Write GOOGLE_CREDENTIAL (or GOOGLE_APPLICATION_CREDENTIALS_JSON) to the file
 * GOOGLE_APPLICATION_CREDENTIALS names, for Google clients that read a file.
 * An image built without secretenv build args carries no credential file, so
 * the server writes it at start. Leaves an existing file alone and never
 * throws. Same rules as agents/livekit/lib/google-credential.ts.
 *
 * @returns {{ status: 'unset'|'no-source'|'present'|'written'|'failed', path?: string, bytes?: number, error?: string }}
 */
export function writeGoogleCredential(env = process.env) {
  const target = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!target) return { status: 'unset' };
  const content = env.GOOGLE_CREDENTIAL || env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!content) return { status: 'no-source', path: target };
  if (fs.existsSync(target)) return { status: 'present', path: target };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { status: 'written', path: target, bytes: content.length };
  } catch (err) {
    if (err.code === 'EEXIST') return { status: 'present', path: target };
    return { status: 'failed', path: target, error: err.message };
  }
}
