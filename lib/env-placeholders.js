/**
 * Treat a value written as <...> as unset. Older copies of environment-example
 * carried placeholders such as `<YOUR OPENAI KEY>`, which otherwise read as
 * real settings: a runtime looked configured and its models were listed.
 */
const PLACEHOLDER = /^\s*<[^>]*>/;

const cleared = new Set();

/** Delete placeholder values from `env`. Returns the names it deleted. */
export function clearPlaceholders(env = process.env) {
  const names = Object.keys(env).filter((name) => typeof env[name] === 'string' && PLACEHOLDER.test(env[name]));
  for (const name of names) {
    delete env[name];
    cleared.add(name);
  }
  return names;
}

/** Every name clearPlaceholders() has deleted in this process. */
export function clearedPlaceholders() {
  return [...cleared];
}
