/**
 * Preserve omitted keyed functions by key reference, even on keyless forks; removal requires removeFunctions. See PR
 * #171. Incoming definitions still win by name, and the result retains the incoming array/object shape.
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
 * The function NAMES on a functions value, in either storage shape. Used where a
 * member's tool set has to be reported compactly (e.g. the set-save stub the
 * chat builder reads back, lib/text-chat.js slimResults).
 */
export function functionNames(functions) {
  return [...entriesOf(functions)]
    .map(([name]) => name)
    .filter((name) => typeof name === 'string');
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
