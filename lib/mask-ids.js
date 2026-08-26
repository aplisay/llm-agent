/**
 * Keep internal identifiers out of anything a builder model can quote at a user.
 *
 * Set/agent/draft ids are platform plumbing. The builder is told as much in its
 * prompt, but a prompt is guidance and a tool result is evidence — asked to
 * explain a failure, the model relays the string it was handed. A builder
 * session whose placeholder set had been deleted mid-conversation told the
 * user, verbatim:
 *
 *   I couldn't save the name because the supplied placeholder set could not be
 *   found: "Agent set <uuid> not found."
 *
 * The model cannot leak what it never received, so the id is removed on the way
 * IN, at the one seam every tool result crosses to reach the conversation. The
 * unmasked message still reaches the server log, where the id is the whole
 * point of having it.
 *
 * Errors themselves are never suppressed — the model must still read what went
 * wrong to correct a payload, and the user must still be told plainly.
 */

/** 8-4-4-4-12 hex: every set, agent, draft and call id we mint. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The id means nothing to a reader, so it goes rather than becoming a
 * placeholder that merely announces an id was here. Removal leaves debris —
 * doubled spaces, a space before punctuation, the empty quotes or brackets it
 * sat in — which this clears so the sentence still reads.
 */
function tidy(text) {
  return text
    .replace(/[([{"'`]\s*[)\]}"'`]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?)\]}])/g, '$1')
    .replace(/([([{])[ \t]+/g, '$1')
    .replace(/[ \t]+$/gm, '');
}

/** Remove every internal id from a string. Non-strings pass through. */
export function maskInternalIds(text) {
  if (typeof text !== 'string' || !text) return text;
  let touched = false;
  const masked = text.replace(UUID, () => {
    touched = true;
    return '';
  });
  return touched ? tidy(masked) : text;
}

/**
 * Mask the `error` of a failed tool result, leaving everything else alone.
 *
 * Deliberately narrow. A SUCCESSFUL set save carries ids the model is meant to
 * have — `slimResults` hands back the post-save set id and member ids so
 * test_agent can resolve a label to an agent — and blanking those would break
 * the build flow. Only the failure branch is a leak.
 */
export function maskToolResultIds(result) {
  if (typeof result !== 'string' || !result.includes('error')) return result;
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    return result; // non-JSON result — not ours to rewrite
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.error !== 'string') return result;
  const error = maskInternalIds(parsed.error);
  if (error === parsed.error) return result;
  return JSON.stringify({ ...parsed, error });
}
