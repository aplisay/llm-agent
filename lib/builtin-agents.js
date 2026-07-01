/**
 * Built-in agents: hardcoded, read-only agent definitions made available to
 * every tenant verbatim. They are not stored in the database — each entry is a
 * factory that binds the (org-agnostic) definition to the requesting user so any
 * org-scoped tools it calls (e.g. create_agent_set) act in that user's org.
 *
 * Built-ins are addressed by a stable, well-known id (e.g. `builtin:set-builder`).
 * They are intentionally NOT listed by GET /agents, and GET /agents/{id} returns
 * display metadata only — the prompt, functions and MCP config are withheld so a
 * built-in's proprietary "recipe" never leaks to clients. They remain usable by
 * their well-known id (e.g. chatted with via POST /agents/{id}/chat) and are
 * rejected (read-only) by PUT/DELETE.
 */
import { setBuilderAgent, SET_BUILDER_AGENT_ID } from './set-builder-agent.js';

// id → (user) => full agent definition bound to that user
const BUILTINS = new Map([
  [SET_BUILDER_AGENT_ID, setBuilderAgent],
]);

export function isBuiltinAgentId(id) {
  return BUILTINS.has(id);
}

/** The built-in agent definition bound to `user`, or null if id is not built-in. */
export function getBuiltinAgent(id, user) {
  const make = BUILTINS.get(id);
  return make ? make(user || {}) : null;
}

/**
 * Public view of a built-in for GET /agents/{id}: display metadata ONLY. The
 * prompt, functions, MCP config and keys are withheld so the built-in's
 * proprietary "recipe" never leaks to clients (a whitelist, so future fields on
 * the definition can't accidentally start leaking).
 */
export function renderBuiltinAgent(id, user) {
  const a = getBuiltinAgent(id, user);
  if (!a) return null;
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    modelName: a.modelName,
    type: a.type,
    readOnly: true,
    builtin: true,
    listeners: [],
  };
}

/**
 * Resolve an agent id for a user to either a built-in definition or a stored
 * agent. Used by operations that should work against both (e.g. chat).
 * @returns {Promise<{agent: object|null, builtin: boolean}>}
 */
export async function resolveAgentForUser(id, user) {
  if (isBuiltinAgentId(id)) {
    return { agent: getBuiltinAgent(id, user), builtin: true };
  }
  const { Agent } = await import('./database.js');
  const { scopeWhereForUser } = await import('./scope.js');
  const agent = await Agent.findOne({ where: { id, ...scopeWhereForUser(user) } });
  return { agent, builtin: false };
}
