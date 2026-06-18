/**
 * In-process agent-set create/update, scoped to a given agent's owner.
 *
 * The HTTP routes (api/paths/agent-sets*) do the same work driven by
 * `res.locals.user`; this module lets server-side callers — specifically the
 * interactive set-builder chat session, via the `create_agent_set` /
 * `update_agent_set` builtins — create and revise sets on behalf of the agent's
 * organisation without going back out through the REST API.
 *
 * It reuses the route helpers (`reconcileMembers`, `renderSet`) rather than
 * duplicating the label-fixup / validation / transaction logic.
 */
import { Agent, AgentSet } from './database.js';
import { scopeWhereForUser } from './scope.js';
import { validateSetLabels } from './agent-set-labels.js';
import { reconcileMembers, renderSet } from '../api/paths/agent-sets.js';

/** Derive the `user` shape the route helpers expect from an agent row/definition. */
function ownerOf(agent) {
  return { id: agent.userId, organisationId: agent.organisationId ?? null };
}

/**
 * Create a set and its members from a document, owned by `agent`'s organisation.
 * @param {{name?:string, description?:string, agents:Array}} doc
 * @param {{userId:string, organisationId?:string}} agent
 * @returns the rendered set (member `keys` never included)
 */
export async function createAgentSetForAgent({ name, description, agents }, agent) {
  const user = ownerOf(agent);
  const byLabel = validateSetLabels(agents);
  const set = await AgentSet.sequelize.transaction(async (transaction) => {
    const created = await AgentSet.create({
      name, description, userId: user.id, organisationId: user.organisationId,
    }, { transaction });
    await reconcileMembers({ set: created, byLabel, user, transaction });
    return created;
  });
  return renderSet(set.id, user);
}

/**
 * Reconcile an existing set against a new document (members matched by label).
 * @param {string} id agent-set id
 * @param {{name?:string, description?:string, agents:Array}} doc
 * @param {{userId:string, organisationId?:string}} agent
 */
export async function updateAgentSetForAgent(id, { name, description, agents }, agent) {
  const user = ownerOf(agent);
  const set = await AgentSet.findOne({ where: { id, ...scopeWhereForUser(user) } });
  if (!set) {
    throw new Error(`Agent set ${id} not found`);
  }
  const byLabel = validateSetLabels(agents);
  await AgentSet.sequelize.transaction(async (transaction) => {
    await set.update({
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
    }, { transaction });
    const existing = await Agent.findAll({ where: { agentSetId: set.id }, transaction });
    await reconcileMembers({ set, byLabel, existing, user, transaction });
  });
  return renderSet(id, user);
}

/**
 * Incrementally patch an existing set WITHOUT resending every member.
 * Upserts only the members in `agents` (matched by label: existing updated, new
 * created); members not listed are left untouched. `removeLabels` deletes members
 * by label. This lets the set builder change one member without re-emitting the
 * whole document — which avoids the output-token truncation that full-state
 * `update_agent_set` hits on large sets.
 *
 * @param {string} id agent-set id
 * @param {{name?:string, description?:string, agents?:Array, removeLabels?:string[]}} doc
 * @param {{userId:string, organisationId?:string}} agent
 */
export async function patchAgentSetForAgent(id, { name, description, agents, removeLabels }, agent) {
  const user = ownerOf(agent);
  const set = await AgentSet.findOne({ where: { id, ...scopeWhereForUser(user) } });
  if (!set) {
    throw new Error(`Agent set ${id} not found`);
  }
  // In patch mode `agents` is the (possibly empty/absent) subset to upsert; only
  // its labels are validated. `removeLabels` lists members to delete.
  const byLabel = Array.isArray(agents) && agents.length ? validateSetLabels(agents) : new Map();
  const remove = Array.isArray(removeLabels) ? removeLabels.filter(Boolean).map(String) : [];
  if (!byLabel.size && !remove.length && name === undefined && description === undefined) {
    throw new Error('patch_agent_set needs at least one of: agents to upsert, removeLabels, name, or description');
  }
  await AgentSet.sequelize.transaction(async (transaction) => {
    await set.update({
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
    }, { transaction });
    const existing = await Agent.findAll({ where: { agentSetId: set.id }, transaction });
    await reconcileMembers({ set, byLabel, existing, user, transaction, patch: true, removeLabels: remove });
  });
  return renderSet(id, user);
}
