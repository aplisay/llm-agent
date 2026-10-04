const isToolsCallsPath = (from) =>
  typeof from === 'string' && (from === 'toolsCalls' || from.startsWith('toolsCalls.'));

const containsToolsCallsInKeys = (keysValue) => {
  if (typeof keysValue !== 'string') return false;
  const tokens = keysValue.split(',').map(k => k.trim()).filter(Boolean);
  return tokens.some(t => t === 'toolsCalls' || t.startsWith('toolsCalls.'));
};

/** True when a function asks for redaction in either form: the whole result, or a list of property names. */
export const redactRequested = (redact) =>
  redact === true || (Array.isArray(redact) && redact.length > 0);

/**
 * The shapes `redact` may take: a boolean, or a non-empty list of non-empty
 * property names (the properties hidden from the model, at any depth of the
 * result). An empty list would be a silent no-op, so it is refused.
 */
export function validateRedactShape(func) {
  const r = func?.redact;
  if (r === undefined || r === null || typeof r === 'boolean') return;
  if (Array.isArray(r)) {
    if (!r.length) {
      throw new Error('redact: an empty list hides nothing — use true, false, or list the property names to hide');
    }
    if (r.some(n => typeof n !== 'string' || !n.trim())) {
      throw new Error('redact: every entry must be a non-empty property name');
    }
    return;
  }
  throw new Error('redact must be true, false, or a list of property names');
}

/**
 * Enforce that references to `metadata.toolsCalls.*` (via tool input `source: "metadata"` paths
 * and the builtin `metadata` helper `keys`) and function-level `redact` (either form) are only
 * allowed on handlers that explicitly opt-in. The shape of `redact` is checked on every handler.
 *
 * The handler opt-in is a static capability flag:
 *   `Handler.hasDynamicMetadata === true`
 */
export function validateToolsCallsMetadataUsage({ Handler, functions }) {
  const functionsObj = functions || {};
  for (const [, func] of Object.entries(functionsObj)) validateRedactShape(func);

  const allowDynamicMetadataFeatures = !!Handler?.hasDynamicMetadata;
  if (allowDynamicMetadataFeatures) return;

  for (const [, func] of Object.entries(functionsObj)) {
    if (redactRequested(func?.redact)) {
      throw new Error('Function result redaction is only allowed in handlers with hasDynamicMetadata');
    }

    // Builtin `metadata` helper can be configured to return specific metadata keys.
    // If it includes `toolsCalls...`, then only LiveKit-style handlers are allowed.
    if (func?.implementation === 'builtin' && func?.platform === 'metadata') {
      const keysParam = func?.input_schema?.properties?.keys;
      if (keysParam?.source === 'static' && containsToolsCallsInKeys(keysParam.from)) {
        throw new Error('Access to metadata.toolsCalls is only allowed in LiveKit agents');
      }
    }

    const properties = func?.input_schema?.properties;
    if (!properties || typeof properties !== 'object') continue;

    for (const [, paramDef] of Object.entries(properties)) {
      if (paramDef?.source === 'metadata' && isToolsCallsPath(paramDef?.from)) {
        throw new Error('Access to metadata.toolsCalls is only allowed in LiveKit agents');
      }
    }
  }
}

