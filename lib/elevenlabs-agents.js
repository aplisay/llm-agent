/**
 * ElevenLabs Agents rows (docs/elevenlabs-agents.md): the LLMs the platform
 * offers behind an ElevenLabs agent, the default voice, and the save-time
 * checks for the names and settings ElevenLabs owns. The worker-side twin is
 * agents/pipecat/pipecat_aplisay/elevenlabs_agents.py; keep the constants in
 * step.
 */

/** The vendor segment of every row (`pipecat:elevenlabs/<llm>`), and the TTS vendor its voices sit under. */
export const ELEVENLABS_VENDOR = 'elevenlabs';

/** The voice a conversation uses when the agent sets none ("Chris" in the ElevenLabs library). */
export const ELEVENLABS_DEFAULT_VOICE = 'cjVigY5qzO86Huf0OWal';

/**
 * The LLMs offered as rows. Each `id` is a value ElevenLabs accepts in
 * `agent.prompt.llm`; the row's model segment is the id verbatim, so the
 * worker passes it through unchanged.
 */
export const ELEVENLABS_AGENT_LLMS = [
  { id: 'gemini-2.5-flash', description: 'Gemini 2.5 Flash' },
  { id: 'gpt-5.4-mini', description: 'GPT-5.4 mini' },
  { id: 'claude-haiku-5-5', description: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-5-5', description: 'Claude Sonnet 5.5' },
];

/** Registry rows for a handler: [vendor, name, description]. */
export function elevenLabsAgentRows(handlerLabel) {
  return ELEVENLABS_AGENT_LLMS.map(({ id, description }) => [
    ELEVENLABS_VENDOR, id, `ElevenLabs Agents, ${description} (${handlerLabel})`,
  ]);
}

/** Names ElevenLabs reserves for its system tools; a client tool cannot take one. */
export const ELEVENLABS_RESERVED_TOOL_NAMES = new Set([
  'end_call',
  'language_detection',
  'skip_turn',
  'transfer_to_agent',
  'transfer_to_number',
  'voicemail_detection',
  'play_keypad_touch_tone',
]);

/**
 * `vendorSpecific.elevenlabs.conversation_config` paths the platform sets
 * itself (the prompt, the LLM, the tools, the audio formats, the events, the
 * duration cap). Dotted.
 */
export const ELEVENLABS_PROTECTED_CONFIG_PATHS = new Set([
  'agent.prompt.prompt',
  'agent.prompt.llm',
  'agent.prompt.tools',
  'agent.prompt.tool_ids',
  'agent.prompt.tool_ids_strict',
  'agent.prompt.built_in_tools',
  'agent.prompt.mcp_server_ids',
  'agent.prompt.native_mcp_server_ids',
  'agent.prompt.knowledge_base',
  'agent.prompt.custom_llm',
  'agent.first_message',
  'tts.voice_id',
  'tts.agent_output_audio_format',
  'asr.user_input_audio_format',
  'conversation.client_events',
  'conversation.text_only',
  'conversation.max_duration_seconds',
]);

/**
 * True for an ElevenLabs Agents row on any handler (`pipecat:elevenlabs/...`,
 * `livekit:elevenlabs/...`). `elevenlabs` as a pipeline `options.tts.vendor`
 * is a different thing and never a model name.
 *
 * @param {string} modelName
 * @returns {boolean}
 */
export function isElevenLabsAgentsModelName(modelName) {
  return /^[a-z0-9_-]+:elevenlabs\//i.test(String(modelName || ''));
}

/**
 * The `vendorSpecific.elevenlabs` block, or null when unset.
 *
 * @param {object} options the agent's options
 * @returns {object | null}
 */
export function elevenLabsVendorBlock(options) {
  const block = options?.vendorSpecific?.elevenlabs;
  return block && typeof block === 'object' && !Array.isArray(block) ? block : null;
}

function protectedPathsIn(config, prefix = '') {
  const found = [];
  for (const [key, value] of Object.entries(config || {})) {
    const path = `${prefix}${key}`;
    if (ELEVENLABS_PROTECTED_CONFIG_PATHS.has(path)) {
      found.push(path);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      found.push(...protectedPathsIn(value, `${path}.`));
    }
  }
  return found;
}

/**
 * Throw when an ElevenLabs Agents agent declares a reserved function name, or
 * asks through `vendorSpecific.elevenlabs` for something the platform owns.
 * No-op on every other model.
 *
 * @param {{ modelName: string, functions?: object | unknown[], options?: object }} agent
 */
export function validateElevenLabsAgent({ modelName, functions, options }) {
  if (!isElevenLabsAgentsModelName(modelName)) return;
  const list = Array.isArray(functions)
    ? functions
    : Object.entries(functions || {}).map(([key, fn]) => ({ ...(fn || {}), name: fn?.name || key }));
  const reserved = list
    .map((fn) => fn?.name)
    .filter((name) => typeof name === 'string' && ELEVENLABS_RESERVED_TOOL_NAMES.has(name));
  if (reserved.length) {
    throw new Error(
      `Function name${reserved.length > 1 ? 's' : ''} ${reserved.map((n) => `"${n}"`).join(', ')} `
      + `reserved by ElevenLabs for its system tools: rename the function (${modelName})`);
  }
  if (options?.vendorSpecific?.elevenlabs === undefined) return;
  const block = elevenLabsVendorBlock(options);
  if (!block) {
    throw new Error('options.vendorSpecific.elevenlabs must be an object');
  }
  for (const key of Object.keys(block)) {
    if (key !== 'conversation_config') {
      throw new Error(
        `options.vendorSpecific.elevenlabs.${key} is not accepted: only conversation_config is `
        + '(platform settings, auth and privacy are the platform\'s)');
    }
  }
  const config = block.conversation_config;
  if (config === undefined) return;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('options.vendorSpecific.elevenlabs.conversation_config must be an object');
  }
  const found = protectedPathsIn(config);
  if (found.length) {
    throw new Error(
      `options.vendorSpecific.elevenlabs.conversation_config.${found[0]} is set by the platform: `
      + 'the prompt, the LLM, the tools, the voice, the audio formats, the events and the duration cap '
      + 'come from the agent itself (docs/elevenlabs-agents.md)');
  }
}
