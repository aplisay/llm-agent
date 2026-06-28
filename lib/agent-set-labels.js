/**
 * Helpers for agent-set label fixup and agent-target validation.
 *
 * Within an /agent-sets document, member agents reference each other in
 * `transfer_agent` / `subagent` builtin functions using shortform labels:
 *
 *   { "agent": { "source": "static", "from": "label:sales" } }
 *
 * On create/update the API resolves those to real agent UUIDs before the
 * agents are saved (model validation requires a UUID). The original label is
 * preserved alongside the resolved id as `fromLabel`, so a set document can be
 * round-tripped: GET returns resolved UUIDs plus their labels, and PUT
 * re-resolves every labelled reference against the (possibly changed) set.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const AGENT_TARGET_PLATFORMS = ['transfer_agent', 'subagent'];

export class AgentSetValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentSetValidationError';
    this.status = 400;
  }
}

export { UUID_REGEX, LABEL_REGEX };

/**
 * Iterate every `agent` target parameter in an agent's functions.
 * Functions are stored either as an array or as an object keyed by function
 * name; both shapes are accepted everywhere in the platform.
 * Yields the property object so callers can mutate `from` in place.
 */
function* agentTargetParams(functions) {
  const list = Array.isArray(functions) ? functions : Object.values(functions || {});
  for (const func of list) {
    if (func?.implementation === 'builtin' && AGENT_TARGET_PLATFORMS.includes(func.platform)) {
      const param = func.input_schema?.properties?.agent;
      if (param) {
        yield { func, param };
      }
    }
  }
}

/**
 * Resolve `label:` references (and stale `fromLabel` annotations) in an
 * agent's functions against a label → agentId map, mutating the function
 * definitions in place.
 *
 * @param {Array} functions agent functions array (mutated)
 * @param {Map<string,string>} labelMap label → agent UUID
 * @param {string} owningLabel label of the agent owning these functions (for error messages)
 * @throws {AgentSetValidationError} on a reference to a label not in the set
 */
export function fixupLabelReferences(functions, labelMap, owningLabel = '?') {
  for (const { func, param } of agentTargetParams(functions)) {
    if (param.source !== 'static') {
      continue;
    }
    let label;
    const fromValue = `${param.from ?? ''}`;
    if (fromValue.startsWith('label:')) {
      label = fromValue.slice('label:'.length);
    } else if (param.fromLabel) {
      // Round-tripped document: re-resolve the original label
      label = `${param.fromLabel}`;
    } else {
      continue;
    }
    if (!labelMap.has(label)) {
      throw new AgentSetValidationError(
        `Agent "${owningLabel}": function ${func.name} references label "${label}" which is not a member of this agent set`);
    }
    param.from = labelMap.get(label);
    param.fromLabel = label;
  }
}

/**
 * Validate every static-UUID agent target in a functions array:
 *  - targets inside `members` (label → member def) are checked for the right
 *    agent type without a database round trip;
 *  - any other UUID is resolved via the supplied `lookupAgent(id)` callback
 *    (scoped to the caller) and checked for existence and type.
 *
 * Expected target types: `transfer_agent` → 'interactive-audio',
 * `subagent` → 'text'.
 *
 * @param {Array} functions agent functions array
 * @param {object} opts
 * @param {Map<string,object>} [opts.membersById] agentId → member agent (in-set targets)
 * @param {Function} [opts.lookupAgent] async (agentId) => agent row or null
 * @param {string} [opts.owningLabel] for error messages
 */
export async function validateAgentTargets(functions, { membersById = new Map(), lookupAgent, owningLabel = '?' } = {}) {
  for (const { func, param } of agentTargetParams(functions)) {
    if (param.source !== 'static') {
      continue;
    }
    const targetId = `${param.from ?? ''}`;
    if (!UUID_REGEX.test(targetId)) {
      // Shape errors are reported by model validation; nothing to resolve here
      continue;
    }
    const expectedType = func.platform === 'subagent' ? 'text' : 'interactive-audio';
    let target = membersById.get(targetId);
    if (!target && lookupAgent) {
      target = await lookupAgent(targetId);
    }
    if (!target) {
      throw new AgentSetValidationError(
        `Agent "${owningLabel}": function ${func.name} references agent ${targetId} which does not exist or is not accessible`);
    }
    const targetType = target.type || 'interactive-audio';
    if (targetType !== expectedType) {
      throw new AgentSetValidationError(
        `Agent "${owningLabel}": function ${func.name} (${func.platform}) must target a ${expectedType} agent, but ${targetId} is type ${targetType}`);
    }
  }
}

/**
 * Validate the `agents` array of an agent-set document: labels present,
 * well-formed, and unique.
 *
 * @param {Array} agents agent-set member definitions
 * @returns {Map<string, object>} label → member definition
 */
export function validateSetLabels(agents) {
  if (!Array.isArray(agents) || !agents.length) {
    throw new AgentSetValidationError('An agent set must contain a non-empty "agents" array');
  }
  const byLabel = new Map();
  for (const member of agents) {
    const label = member?.label;
    if (!label || typeof label !== 'string' || !LABEL_REGEX.test(label)) {
      throw new AgentSetValidationError(
        `Every agent in a set needs a "label" matching ${LABEL_REGEX} (got ${JSON.stringify(label)})`);
    }
    if (byLabel.has(label)) {
      throw new AgentSetValidationError(`Duplicate agent label "${label}" in agent set`);
    }
    byLabel.set(label, member);
  }
  return byLabel;
}
