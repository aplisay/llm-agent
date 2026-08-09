/**
 * Fail-closed guard against destroying agents that still hold real-world
 * wiring (a phone number or SIP registration bound through an Instance).
 *
 * Destroying an Agent cascades to its Instances, and PhoneNumber /
 * PhoneRegistration rows detach via SET NULL — so an unguarded delete
 * silently disconnects a live endpoint. Every agent-destroying path
 * (set reconcile, set delete, agent delete) asserts through here first;
 * callers must explicitly undeploy (DELETE /listener/{id}) before removing
 * a wired agent. Bare WebRTC listeners never block — they are transient
 * test sessions with nothing bound to them.
 */
import { Instance, PhoneNumber, PhoneRegistration } from './database.js';

export class WiredListenerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WiredListenerError';
    this.status = 409;
  }
}

/** Instances on the given agents that hold a phone number or registration. */
export async function wiredListeners(agentIds, { transaction } = {}) {
  if (!agentIds.length) {
    return [];
  }
  const instances = await Instance.findAll({
    where: { agentId: agentIds },
    include: [
      { model: PhoneNumber, as: 'number' },
      { model: PhoneRegistration, as: 'registration' },
    ],
    transaction,
  });
  return instances.filter((instance) => instance.number || instance.registration);
}

/**
 * Throw WiredListenerError (409) if any of the given agent rows still has a
 * phone number or registration listening on it.
 * @param {Array<{id:string,label?:string,name?:string}>} agents rows about to be destroyed
 */
export async function assertAgentsNotWired(agents, { transaction } = {}) {
  const wired = await wiredListeners(agents.map((agent) => agent.id), { transaction });
  if (!wired.length) {
    return;
  }
  const describe = (instance) => {
    const agent = agents.find((a) => a.id === instance.agentId);
    const who = agent?.label || agent?.name || instance.agentId;
    const endpoint = instance.number
      ? `+${instance.number.number}`
      : `registration ${instance.registration.name || instance.registration.id}`;
    return `"${who}" answers ${endpoint}`;
  };
  throw new WiredListenerError(
    `In use: ${wired.map(describe).join('; ')} — disconnect the endpoint(s) before deleting the agent(s)`);
}
