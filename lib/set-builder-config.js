// Settings of the agent-set builder, in one place so the built-in agent and
// GET /api/health agree. No imports: config-status.js must stay cheap to load.

export const DEFAULT_SET_BUILDER_MODEL = 'text:openai/gpt-5.6-terra';

const MCP_URL = 'https://mcp.aplisay.com/mcp';
// The next channel tracks the API on the `next` branch.
const MCP_URL_NEXT = 'https://mcp-next.aplisay.com/mcp';

export function setBuilderModel(env = process.env) {
  return env.SET_BUILDER_MODEL || DEFAULT_SET_BUILDER_MODEL;
}

// The docs the builder reads must match the API it drives. Development and
// staging run the `next` branch, so they read the next channel. Everything
// else, a self-hosted release included, reads the released docs.
export function setBuilderMcpUrl(env = process.env) {
  if (env.SET_BUILDER_MCP_URL) return env.SET_BUILDER_MCP_URL;
  return ['development', 'staging', 'feature'].includes(env.NODE_ENV) ? MCP_URL_NEXT : MCP_URL;
}

// The provider segment of a model name such as text:openai/gpt-5.6-terra.
export function modelProvider(modelName) {
  return String(modelName || '').split(':')[1]?.split('/')[0] || null;
}
