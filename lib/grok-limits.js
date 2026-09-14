/**
 * Reject reserved names and xAI server tools at save time; server tools bypass platform logging and access controls.
 * Workers also strip them from legacy rows; see docs/grok.md.
 */

/** Function names xAI reserves for its server-side tools. */
export const XAI_RESERVED_TOOL_NAMES = new Set([
  'web_search',
  'browse_page',
  'x_keyword_search',
  'x_semantic_search',
  'x_user_search',
  'x_thread_fetch',
  'collections_search',
  'file_search',
]);

/** Session tool types that mean a server-side tool. */
export const XAI_SERVER_TOOL_TYPES = new Set(['mcp', 'web_search', 'x_search', 'file_search']);

/**
 * True for a Grok voice row on any handler (`pipecat:xai/grok-voice-...`,
 * `livekit:xai/grok-voice-...`). Text rows and the pipeline rows are not
 * realtime sessions and carry no `vendorSpecific.xai.session`.
 *
 * @param {string} modelName
 * @returns {boolean}
 */
export function isXaiVoiceModelName(modelName) {
  return /^[a-z0-9_-]+:xai\/grok-voice/i.test(String(modelName || ''));
}

/**
 * The `vendorSpecific.xai.session` object, or `null` when unset or not an
 * object.
 *
 * @param {object} options the agent's options
 * @returns {object | null}
 */
export function xaiSessionOverrides(options) {
  const xai = options?.vendorSpecific?.xai;
  const session = xai && typeof xai === 'object' ? xai.session : undefined;
  return session && typeof session === 'object' && !Array.isArray(session) ? session : null;
}

/**
 * Throw when a Grok voice agent declares a reserved function name or asks
 * for server-side tools through `vendorSpecific`. No-op on every other model.
 *
 * @param {{ modelName: string, functions?: object | unknown[], options?: object }} agent
 */
export function validateXaiVoiceAgent({ modelName, functions, options }) {
  if (!isXaiVoiceModelName(modelName)) return;
  const list = Array.isArray(functions)
    ? functions
    : Object.entries(functions || {}).map(([key, fn]) => ({ ...(fn || {}), name: fn?.name || key }));
  const reserved = list
    .map((fn) => fn?.name)
    .filter((name) => typeof name === 'string' && XAI_RESERVED_TOOL_NAMES.has(name));
  if (reserved.length) {
    throw new Error(
      `Function name${reserved.length > 1 ? 's' : ''} ${reserved.map((n) => `"${n}"`).join(', ')} `
      + `reserved by xAI for its server-side tools: rename the function (${modelName})`);
  }
  const session = xaiSessionOverrides(options);
  if (!session) return;
  if (session.tools !== undefined) {
    throw new Error(
      'options.vendorSpecific.xai.session.tools is not accepted: declare tools in the agent\'s '
      + 'functions and mcpServers, xAI server-side tools are not offered');
  }
  for (const [key, value] of Object.entries(session)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      const type = entry && typeof entry === 'object' ? entry.type : undefined;
      if (typeof type === 'string' && XAI_SERVER_TOOL_TYPES.has(type)) {
        throw new Error(
          `options.vendorSpecific.xai.session.${key} carries an xAI server-side tool `
          + `(type "${type}"), which is not offered`);
      }
    }
  }
}
