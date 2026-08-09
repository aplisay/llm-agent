/**
 * Shared env-file selection for the ops scripts in this directory, matching the
 * tools/ CLI convention:
 *
 *   node scripts/<script>.mjs -p /path/to/staging.env
 *
 * `-p <file>` / `--path <file>` / `--path=<file>` selects the env file so the
 * same script can be pointed at any environment from one machine. Falls back to
 * ENV_FILE / DOTENV_CONFIG_PATH, then the repo-root .env. An EXPLICITLY
 * requested file that can't be read is a hard error — never silently fall back
 * to the dev .env and run against the wrong environment.
 */
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

export function loadEnv(argv = process.argv) {
  let requested = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '-p' || argv[i] === '--path') { requested = argv[i + 1]; break; }
    if (argv[i].startsWith('--path=')) { requested = argv[i].slice('--path='.length); break; }
  }
  requested ||= process.env.ENV_FILE || process.env.DOTENV_CONFIG_PATH || null;

  const here = dirname(fileURLToPath(import.meta.url));
  const path = requested ? resolve(process.cwd(), requested) : join(here, '..', '.env');
  const result = dotenv.config({ path });
  if (requested && result.error) {
    console.error(`Cannot read env file ${path}: ${result.error.message}`);
    process.exit(1);
  }
  console.log(`[env] ${path}${result.error ? ' (not found — using process env only)' : ''}`);
  return path;
}
