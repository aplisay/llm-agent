/**
 * Built-in agents: hardcoded, read-only agent definitions made available to
 * every tenant verbatim. They are not stored in the database — each entry is a
 * factory that binds the (org-agnostic) definition to the requesting user so any
 * org-scoped tools it calls (e.g. create_agent_set) act in that user's org.
 *
 * Built-ins are addressed by a stable, well-known id (e.g. `builtin:set-builder`)
 * and surface through the normal agent API: they appear in GET /agents, can be
 * fetched with GET /agents/{id}, chatted with via POST /agents/{id}/chat, and
 * are rejected (read-only) by PUT/DELETE.
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

/** Read-only summary rows (AgentListItem shape) for inclusion in GET /agents. */
export function listBuiltinAgentSummaries() {
  return [...BUILTINS.values()].map((make) => {
    const a = make({});
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      modelName: a.modelName,
      type: a.type,
      readOnly: true,
      builtin: true,
      createdAt: null,
      updatedAt: null,
    };
  });
}

/** Public view of a built-in for GET /agents/{id} (keys stripped, read-only). */
export function renderBuiltinAgent(id, user) {
  const a = getBuiltinAgent(id, user);
  if (!a) return null;
  return { ...a, keys: undefined, readOnly: true, builtin: true, listeners: [] };
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
