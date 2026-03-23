/**
 * Resolve an arbitrary-depth dot-path against an object.
 *
 * Examples:
 * - getByPath({ a: { b: 1 } }, "a.b") -> 1
 * - getByPath({ toolsCalls: { t1: { result: { name: "x" }}}}, "toolsCalls.t1.result.name") -> "x"
 *
 * Notes:
 * - Supports numeric segments as array indices (e.g. "items.0.name")
 * - Returns `undefined` if any segment is missing
 */
function getByPath(obj, dotPath) {
  if (!obj || typeof dotPath !== 'string') return undefined;
  const trimmed = dotPath.trim();
  if (!trimmed) return undefined;

  const segments = trimmed.split('.').filter(Boolean);
  return segments.reduce((acc, segment) => {
    if (acc === undefined || acc === null) return undefined;
    if (Array.isArray(acc) && /^\d+$/.test(segment)) {
      return acc[Number(segment)];
    }
    return acc[segment];
  }, obj);
}

export { getByPath };

