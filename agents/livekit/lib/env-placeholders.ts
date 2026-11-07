/**
 * Treat a value written as <...> as unset, as the API server does
 * (lib/env-placeholders.js). Older copies of environment-example carried
 * placeholders such as `<LIVEKIT API KEY>`, which otherwise read as settings.
 */
const PLACEHOLDER = /^\s*<[^>]*>/;

/** Delete placeholder values from `env`. Returns the names it deleted. */
export function clearPlaceholders(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = Object.keys(env).filter((name) => PLACEHOLDER.test(env[name] ?? ""));
  for (const name of names) delete env[name];
  return names;
}
