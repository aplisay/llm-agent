/**
 * Model access control (R1) — a per-user/per-org allow-list of modelName
 * PREFIXES that constrains which models a principal may list, read and use.
 *
 * A modelName is `[<handler>:]<provider>/<model>` (built at
 * lib/handlers/handler.js:81, e.g. `text:anthropic/claude-opus-4-8`,
 * `pipecat:ultravox/ultravox-v0.7`, `livekit:openai-realtime/gpt-realtime`).
 *
 * Prefix grammar (each entry in the list):
 *   `*`                                  → any model (wildcard)
 *   `text:`                              → any text model
 *   `pipecat:ultravox`                   → that handler+family
 *   `livekit:openai-realtime/gpt-realtime` → that exact model
 *   `builtin:` / `builtin:set-builder`   → built-in agents (their stable well-known
 *                                          id IS the access identity), so built-ins
 *                                          can be granted/denied independently of
 *                                          user agents — e.g. ['builtin:set-builder']
 *                                          allows the set-builder but no `text:` user
 *                                          agents.
 *
 * Matching is BOUNDARY-AWARE: a prefix matches only at a structural boundary
 * (`:` or `/`), so `pipecat:ultravox` matches `pipecat:ultravox/*` but NOT a
 * hypothetical `pipecat:ultravoxXL/*`.
 *
 * The effective list is the UNION of four sources (F1/F3):
 *   org role-default models ∪ org.allowedModels ∪ user role-default models ∪ user.allowedModels
 * An empty list contributes nothing; if the total union is empty OR contains
 * `*`, the principal is UNRESTRICTED (represented as `null`).
 */
import { modelsFor } from './permissions.js';

/** Does `modelName` match a single prefix `prefix`, respecting `:`/`/` boundaries? */
export function matchModelPrefix(modelName, prefix) {
  if (prefix === '*') return true;
  if (typeof modelName !== 'string' || typeof prefix !== 'string' || !prefix) return false;
  if (modelName === prefix) return true;
  if (!modelName.startsWith(prefix)) return false;
  const endsOnBoundary = prefix.endsWith(':') || prefix.endsWith('/');
  const next = modelName[prefix.length];
  return endsOnBoundary || next === ':' || next === '/';
}

/**
 * Union the given prefix lists. Returns `null` (== unrestricted) when the union
 * is empty or contains the `*` wildcard; otherwise the de-duplicated list.
 */
function unionModels(...lists) {
  const merged = [...new Set(lists.flat().filter(Boolean))];
  if (merged.length === 0 || merged.includes('*')) return null;
  return merged;
}

/**
 * The effective allow-list for `user` within `org` (its organisation row),
 * drawing from the role defaults and the explicit `allowedModels` columns of
 * both. `null` means no restriction.
 */
export function effectiveAllowedModels(user, org) {
  return unionModels(
    modelsFor(org?.role), org?.allowedModels,
    modelsFor(user?.role), user?.allowedModels,
  );
}

/**
 * Is `modelName` permitted under `allowedList` (the result of
 * `effectiveAllowedModels`)? A `null` list is unrestricted ⇒ always `true`.
 */
export function isModelAllowed(modelName, allowedList) {
  if (allowedList == null) return true;
  return allowedList.some((prefix) => matchModelPrefix(modelName, prefix));
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

/**
 * Build a Sequelize `where` fragment (on the `modelName` column) equivalent to
 * `isModelAllowed`, so a listing query can be filtered IN THE DATABASE and stay
 * correctly paginated. Returns `null` when unrestricted (caller adds no
 * constraint). `Op` is passed in to avoid importing sequelize here.
 *
 * Mirrors the boundary-aware semantics of `matchModelPrefix`: a prefix ending
 * in a boundary (`:`/`/`) is a plain LIKE; otherwise it matches the exact value
 * or the value followed by a `:`/`/` boundary.
 */
export function allowedModelsWhere(allowedList, Op) {
  if (allowedList == null) return null; // unrestricted
  const ors = [];
  for (const p of allowedList) {
    if (typeof p !== 'string' || !p) continue; // skip non-string/falsy (mirror matchModelPrefix; never throw on a poisoned legacy row)
    if (p === '*') return null;
    if (p.endsWith(':') || p.endsWith('/')) {
      ors.push({ modelName: { [Op.like]: `${escapeLike(p)}%` } });
    } else {
      ors.push({ modelName: p });
      ors.push({ modelName: { [Op.like]: `${escapeLike(p)}:%` } });
      ors.push({ modelName: { [Op.like]: `${escapeLike(p)}/%` } });
    }
  }
  return { [Op.or]: ors };
}

export default { matchModelPrefix, effectiveAllowedModels, isModelAllowed, allowedModelsWhere };
