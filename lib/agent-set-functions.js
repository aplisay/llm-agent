/**
 * Preservation of platform-wired (keyed) member functions across agent-set
 * saves.
 *
 * Set documents are CONTENT: a builder session (or a versioning service)
 * round-trips them and writes each member back wholesale. But some functions on
 * a member row are WIRING, not content — a platform panel (e.g. polite-ai's
 * calendar-booking or email-notify attach flow) injects rest functions directly
 * onto the saved rows and arms the write-only `Agent.keys` entry they reference
 * (their `key` property, e.g. "POLITE_BOOKING"). A document produced before the
 * injection doesn't contain them, so a naive replace-on-save silently strips
 * the wiring from the team (the 2026-07-25 beta incident class).
 *
 * The invariant: a function that REFERENCES a keys entry was necessarily wired
 * by a caller with key custody — key values are write-only and never round-trip
 * through GET, so no document-driven editor can faithfully re-author one.
 * Removing such a function must therefore be EXPLICIT: a member definition may
 * carry `removeFunctions: ["name", ...]` alongside `functions`; omission alone
 * never strips a keyed function. An incoming function with the same name still
 * wins, which is how the panels themselves update their wiring in place.
 *
 * The rule keys on the key REFERENCE, not on the key being armed: versioning
 * paths fork fresh rows keyless (a platform sweep re-arms them asynchronously),
 * so requiring an armed key would reopen exactly the window being closed.
 *
 * Functions are stored either as an array or as an object keyed by function
 * name; both shapes are accepted everywhere in the platform and both are
 * handled here. The merged result keeps the INCOMING document's shape.
 */

/** True when a function definition references a write-only Agent.keys entry. */
export function isKeyedFunction(fn) {
  return !!fn && typeof fn === 'object' && typeof fn.key === 'string' && fn.key.length > 0;
}

/**
 * Iterate a functions value (array, or object keyed by function name) as
 * [name, fn] pairs. Array entries take their name from `fn.name`; object
 * entries fall back to their object key when the value carries no name.
 */
function* entriesOf(functions) {
  if (Array.isArray(functions)) {
    for (const fn of functions) {
      if (fn && typeof fn === 'object') {
        yield [typeof fn.name === 'string' ? fn.name : undefined, fn];
      }
    }
  } else if (functions && typeof functions === 'object') {
    for (const [key, fn] of Object.entries(functions)) {
      if (fn && typeof fn === 'object') {
        yield [typeof fn.name === 'string' ? fn.name : key, fn];
      }
    }
  }
}

/**
 * Merge a member's stored functions into the incoming definition for a set
 * save.
 *
 *  - Keyed functions present on the row but absent from the document are
 *    preserved (appended), unless their name is listed in `removeNames`.
 *  - An incoming function always replaces a stored one of the same name.
 *  - Unkeyed stored functions keep today's semantics: the document replaces
 *    them wholesale.
 *  - With no incoming `functions` at all, the stored value is left untouched —
 *    except that `removeNames` still deletes the named functions (keyed or
 *    not), so a remove-only patch works without resending the member's tools.
 *
 * @param {Array|object|null|undefined} prior functions stored on the row
 * @param {Array|object|undefined} incoming functions from the document
 *   (undefined = field not supplied)
 * @param {string[]} [removeNames] function names to delete explicitly
 * @returns the merged value in the incoming document's shape, or undefined
 *   when the stored field should be left untouched
 */
export function mergeMemberFunctions(prior, incoming, removeNames = []) {
  const remove = new Set((Array.isArray(removeNames) ? removeNames : []).filter(Boolean).map(String));

  if (incoming === undefined) {
    if (!remove.size || prior === undefined || prior === null) {
      return undefined;
    }
    // Remove-only: drop the named functions, keeping the stored shape.
    if (Array.isArray(prior)) {
      return prior.filter((fn) => !remove.has(`${fn?.name ?? ''}`));
    }
    return Object.fromEntries([...entriesOf(prior)].filter(([name]) => !remove.has(`${name}`)));
  }

  const incomingNames = new Set(
    [...entriesOf(incoming)].map(([name]) => name).filter((name) => name !== undefined));
  const preserved = [...entriesOf(prior)].filter(([name, fn]) =>
    isKeyedFunction(fn) && !incomingNames.has(name) && !remove.has(`${name}`));

  if (Array.isArray(incoming)) {
    // Entries preserved from an object-shaped store may carry their name only
    // as the object key — materialise it, an array entry has nowhere else.
    return [...incoming, ...preserved.map(([name, fn]) => (fn.name === name ? fn : { ...fn, name }))];
  }
  return { ...incoming, ...Object.fromEntries(preserved) };
}
