/**
 * Listener-level transfer overrides (docs/transfer-back-plan.md).
 *
 * `POST /agents/{agentId}/listen` may carry `options.bridgedTransferToAgent`,
 * `options.bridgedTransferTranscribe` and `options.dtmfTimeout`. Each one,
 * when present, wholesale-replaces the same-named agent option for every call
 * that arrives on the created listener (the workers merge instance-over-agent,
 * mirroring the `recording` override).
 *
 * Unlike a plain `PUT /agents/{id}`, the hand-back map here may use `label:`
 * shortforms when the agent is a member of an agent set — they are resolved
 * against the set's members at activation time and stored as UUIDs annotated
 * with `fromLabel`, exactly as an /agent-sets document save would.
 */

import {
  Agent,
  validateBridgedTransferToAgentShape,
  validateBridgedTransferTranscribeShape,
} from './database.js';
import {
  fixupLabelReferences,
  validateAgentTargets,
  AgentSetValidationError,
} from './agent-set-labels.js';

const DTMF_TIMEOUT_RANGE = [100, 60000];

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

/**
 * Validate and resolve the listener-level transfer overrides for one
 * activation. Returns the values to store on the Instance row (the hand-back
 * map deep-copied with `label:` references resolved to UUIDs); each returned
 * field is `undefined` when the caller did not supply it.
 *
 * @param {object} params
 * @param {object} params.agent the (already loaded) agent row being activated
 * @param {object} params.Handler the agent's handler class (static capability flags)
 * @param {object} [params.bridgedTransferToAgent] candidate hand-back map
 * @param {boolean|object} [params.bridgedTransferTranscribe] candidate transcribe setting
 * @param {number} [params.dtmfTimeout] candidate inter-digit timeout (ms)
 * @throws {Error} status-400 error on any validation failure
 */
export async function resolveListenerTransferOverrides({
  agent,
  Handler,
  bridgedTransferToAgent,
  bridgedTransferTranscribe,
  dtmfTimeout,
} = {}) {
  const resolved = {};

  if (dtmfTimeout !== undefined && dtmfTimeout !== null) {
    const [lo, hi] = DTMF_TIMEOUT_RANGE;
    if (typeof dtmfTimeout !== 'number' || !Number.isInteger(dtmfTimeout)
      || dtmfTimeout < lo || dtmfTimeout > hi) {
      fail(`options.dtmfTimeout must be an integer number of milliseconds between ${lo} and ${hi}`);
    }
    resolved.dtmfTimeout = dtmfTimeout;
  }

  if (bridgedTransferTranscribe !== undefined && bridgedTransferTranscribe !== null) {
    validateBridgedTransferTranscribeShape(bridgedTransferTranscribe, {
      hasTransfer: Handler.hasTransfer,
      modelName: agent.modelName,
    });
    resolved.bridgedTransferTranscribe = bridgedTransferTranscribe;
  }

  if (bridgedTransferToAgent !== undefined && bridgedTransferToAgent !== null) {
    if (typeof bridgedTransferToAgent !== 'object' || Array.isArray(bridgedTransferToAgent)) {
      fail('options.bridgedTransferToAgent must be an object mapping DTMF sequences to agent references');
    }
    // Deep copy so label resolution never mutates the caller's request body
    const map = structuredClone(bridgedTransferToAgent);

    // Resolve label: references against the agent's set, when it is in one.
    // fixupLabelReferences skips plain-UUID entries, so building the map is
    // only needed when a label is actually referenced.
    const wantsLabels = Object.values(map).some((value) => {
      const entry = typeof value === 'string' ? { agent: value } : value;
      return `${entry?.agent ?? ''}`.startsWith('label:') || entry?.fromLabel;
    });
    let membersById = new Map();
    if (wantsLabels) {
      if (!agent.agentSetId) {
        throw new AgentSetValidationError(
          'options.bridgedTransferToAgent uses label: references, but this agent is not a member of an agent set');
      }
      const members = await Agent.findAll({
        where: { agentSetId: agent.agentSetId },
        attributes: ['id', 'label', 'type', 'modelName'],
      });
      const labelMap = new Map(members.filter((m) => m.label).map((m) => [m.label, m.id]));
      membersById = new Map(members.map((m) => [m.id, m]));
      fixupLabelReferences([], labelMap, agent.label || agent.name, { bridgedTransferToAgent: map });
    }

    // Now every entry is UUID-form: structural validation (same rules and
    // messages as the agent-side option)...
    validateBridgedTransferToAgentShape(map, {
      hasTransfer: Handler.hasTransfer,
      hasAgentTransfer: Handler.hasAgentTransfer,
      modelName: agent.modelName,
    });
    // ...and every target must exist in this organisation and be a voice agent
    await validateAgentTargets([], {
      membersById,
      lookupAgent: (agentId) => Agent.findOne({
        where: { id: agentId, organisationId: agent.organisationId },
      }),
      owningLabel: agent.label || agent.name,
      options: { bridgedTransferToAgent: map },
    });
    resolved.bridgedTransferToAgent = map;
  }

  return resolved;
}
