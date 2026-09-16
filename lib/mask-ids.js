/**
 * Mask internal ids in failed tool results before they reach the model; keep the unmasked error in server logs. See
 * PR #257.
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
 * Mask failures only: successful saves return ids the builder needs for later tool calls. See PR #257.
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
