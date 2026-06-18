/**
 * The "set builder": an in-memory `text` agent definition (not a stored Agent
 * row) that the interactive chat session runs to help a user design and create
 * an agent set. It is instantiated per request, scoped to the calling user's
 * organisation, so the `create_agent_set` / `update_agent_set` builtins it calls
 * write into that org.
 *
 * Model and MCP endpoint are env-configurable. The system prompt embeds the
 * essential agent-set rules so the builder is useful immediately; once the
 * Anthropic implementation honours `mcpServers` (the MCP connector) it will also
 * read the live Aplisay API reference and docs at call time.
 */

const MODEL = process.env.SET_BUILDER_MODEL || 'text:anthropic/claude-opus-4-8';
const MCP_URL = process.env.SET_BUILDER_MCP_URL || 'https://mcp.aplisay.com/mcp';

// Stable, well-known id under which the set builder is exposed as a read-only
// built-in agent to every tenant (see lib/builtin-agents.js).
export const SET_BUILDER_AGENT_ID = 'builtin:set-builder';

const SYSTEM_PROMPT = `You are the Aplisay Set Builder. You help a user design and create an "agent set" — a
team of voice and text agents that work together on phone/WebRTC calls — and then create it for them
via your tools. Be concise and collaborative: understand the goal, propose a design, confirm, create.

You have an Aplisay MCP server available; when you can, use it to read the live LLM Agent API reference
and the "multi-agent" documentation rather than relying on memory. The essentials:

AGENT SET DOCUMENT
  { "name": string, "description": string, "agents": [ member, ... ] }
Each member is an ordinary agent definition plus a set-unique "label":
  { "label": "sales", "name": "Sales", "modelName": "...", "prompt": "...", "functions": [ ... ] }
- label: unique within the set, matching ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ — used for intra-set references.
- modelName: a handler-prefixed model, e.g. "livekit:ultravox/ultravox-70b" or "pipecat:openai/gpt-4o-realtime"
  for VOICE (interactive-audio) agents, or "text:anthropic/..." / "text:openai/..." for TEXT agents.
  The type is inferred from the prefix ("text:" → a text agent).
- prompt: the agent's own system prompt. Write it so the agent introduces itself when it takes a call.

LINKING AGENTS (builtin functions on a member's "functions")
- transfer_agent: hand a LIVE call from one voice agent to another (one-way handover). Target voice agent.
- subagent: a voice OR text agent calls a TEXT agent like a tool and gets a result back (ask → result).
- result: a TEXT agent's output contract — it ends by calling this with its answer.
A builtin function looks like:
  { "name": "to_sales", "implementation": "builtin", "platform": "transfer_agent",
    "input_schema": { "properties": { "agent": { "type": "string", "source": "static", "from": "label:sales" },
      "summary": { "type": "string", "description": "Handover note" } } } }
Reference other members with { "source": "static", "from": "label:<label>" } in the "agent" parameter —
the platform resolves labels to real IDs on create. transfer_agent must target a voice agent; subagent a text agent.

WHEN READY
- Call create_agent_set with { name, description, agents } to create the whole team in one go.
- To revise a set you already created this session, call update_agent_set with { id, name, description, agents }
  (members are reconciled by label: existing updated, new created, missing deleted).
Confirm the design with the user before creating. After creating, briefly summarise what you made.`;

/** create_agent_set / update_agent_set builtins exposed to the builder. */
const createSetFunction = {
  name: 'create_agent_set',
  implementation: 'builtin',
  platform: 'create_agent_set',
  description: 'Create the agent set once the design is agreed. Pass the complete set document.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Display name for the set' },
      description: { type: 'string', description: 'Short description of what the set does' },
      agents: { type: 'array', description: 'Array of member agent definitions, each with a unique "label"' },
    },
    required: ['agents'],
  },
};

const updateSetFunction = {
  name: 'update_agent_set',
  implementation: 'builtin',
  platform: 'update_agent_set',
  description: 'Revise a set created earlier this session. Members are reconciled by label.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id of the set to update (from a previous create_agent_set result)' },
      name: { type: 'string' },
      description: { type: 'string' },
      agents: { type: 'array', description: 'The full desired set of members' },
    },
    required: ['id', 'agents'],
  },
};

/**
 * Build the set-builder agent definition for a given user.
 * @param {{id:string, organisationId?:string}} user — typically res.locals.user
 */
export function setBuilderAgent(user) {
  return {
    id: SET_BUILDER_AGENT_ID,
    name: 'Aplisay Set Builder',
    description: 'Designs and creates agent sets (teams of agents) conversationally, grounded in the Aplisay API and docs.',
    userId: user.id,
    organisationId: user.organisationId ?? null,
    type: 'text',
    modelName: MODEL,
    prompt: SYSTEM_PROMPT,
    // Roomy output budget so a full multi-agent set document fits in one
    // create_agent_set tool call. (No temperature — current models reject it.)
    options: { maxTokens: 8192 },
    keys: [],
    mcpServers: [{ name: 'aplisay', url: MCP_URL, transport: 'streamable_http' }],
    functions: [createSetFunction, updateSetFunction],
  };
}

export const SET_BUILDER_MODEL = MODEL;
