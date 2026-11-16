/**
 * The number to offer for a new extension. Pure.
 */
import { isReservedExtensionNumber } from '../database-models/extension.js';

const DEFAULT_LENGTH = 3;

/** The length most of the numbers have. A tie goes to the longer, which has more room. */
function commonLength(numbers) {
  const counts = new Map();
  for (const number of numbers) counts.set(number.length, (counts.get(number.length) || 0) + 1);
  let best = null;
  for (const [length, count] of counts) {
    if (!best || count > best.count || (count === best.count && length > best.length)) best = { length, count };
  }
  return best?.length ?? DEFAULT_LENGTH;
}

/**
 * The lowest free number with as many digits as `near`, or as most of the
 * organisation's numbers have. It never starts with 0 and never is or begins
 * with an emergency number. Null when every number of that length is taken.
 *
 * @param {string[]} numbers  the numbers of the organisation's live extensions
 * @param {string} [near]     digits whose length to match
 */
export function nextExtensionNumber(numbers, near) {
  const used = new Set(numbers);
  const length = /^[0-9]{1,8}$/.test(String(near ?? '')) ? String(near).length : commonLength(numbers);
  const first = length === 1 ? 1 : 10 ** (length - 1);
  const last = 10 ** length - 1;
  for (let n = first; n <= last; n++) {
    const candidate = String(n);
    if (!used.has(candidate) && !isReservedExtensionNumber(candidate)) return candidate;
  }
  return null;
}
