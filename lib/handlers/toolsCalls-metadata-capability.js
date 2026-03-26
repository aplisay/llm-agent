const isToolsCallsPath = (from) =>
  typeof from === 'string' && (from === 'toolsCalls' || from.startsWith('toolsCalls.'));

const containsToolsCallsInKeys = (keysValue) => {
  if (typeof keysValue !== 'string') return false;
  const tokens = keysValue.split(',').map(k => k.trim()).filter(Boolean);
  return tokens.some(t => t === 'toolsCalls' || t.startsWith('toolsCalls.'));
};

/**
 * Enforce that references to `metadata.toolsCalls.*` (via tool input `source: "metadata"` paths
 * and the builtin `metadata` helper `keys`) and function-level `redact` are only allowed on
 * handlers that explicitly opt-in.
 *
 * The handler opt-in is a static capability flag:
 *   `Handler.hasDynamicMetadata === true`
 */
export function validateToolsCallsMetadataUsage({ Handler, functions }) {
  const allowDynamicMetadataFeatures = !!Handler?.hasDynamicMetadata;
  if (allowDynamicMetadataFeatures) return;

  const functionsObj = functions || {};
  for (const [, func] of Object.entries(functionsObj)) {
    if (func?.redact === true) {
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

