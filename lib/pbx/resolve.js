/**
 * Answers call control's question "what should this call do?". It finds the
 * organisation the request belongs to, loads its directory, and builds the
 * ring plan (lib/pbx/ring-plan.js). A call that belongs to an agent gets a
 * plan that names the agent, with no directory read.
 *
 * The organisation always comes from a row the request names (a number on a
 * trunk, a registration, a line's SIP username), never from a bare field,
 * except for the follow-up kinds that call control sends about a call it
 * already holds.
 */
import { randomUUID } from 'node:crypto';
import { Organisation, PhoneNumber, PhoneRegistration, Line, Instance, Agent } from '../database.js';
import { normalizeE164 } from '../validation.js';
import { inboundNumberWhere } from '../inbound-number.js';
import { indexSnapshot } from './snapshot.js';
import { loadSnapshot } from './store.js';
import { buildRingPlan, agentStep, phonesStopped, PLAN_TTL_SECONDS } from './ring-plan.js';
import { isDeviceLine } from './line-accounts.js';
import { PbxError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const base = (organisationId = null) => ({ planId: `p-${randomUUID()}`, ttlSeconds: PLAN_TTL_SECONDS, organisationId });
const refusal = (reason, organisationId) => ({ ...base(organisationId), action: 'refuse', reason });

async function planFor(organisationId, request, opts) {
  const snapshot = await loadSnapshot(organisationId);
  if (!snapshot) return refusal('organisation_not_found');
  return buildRingPlan(indexSnapshot(snapshot), request, opts);
}

/**
 * The plan for a call that goes straight to the agent listening as
 * `instanceId`. Not a phone system call: no capability is looked at, so it
 * answers for any organisation.
 */
async function agentPlan(instanceId, organisationId) {
  const row = await Instance.findByPk(instanceId, {
    attributes: ['id', 'agentId', 'type', 'organisationId'],
    include: [{ model: Agent, attributes: ['id'] }],
  });
  // An instance whose agent is gone takes no call: the workers refuse it too.
  const instance = row?.Agent ? { id: row.id, agentId: row.agentId, runtime: row.type } : null;
  const step = agentStep(instance);
  // A refusal names no organisation: call control records a refused call
  // against the organisation it is given, as a phone system call.
  return { ...base(step.action === 'agent' ? (row.organisationId ?? organisationId) : null), ...step };
}

async function organisationDeactivated(organisationId) {
  if (!organisationId) return false;
  return phonesStopped(await Organisation.findByPk(organisationId, { attributes: ['id', 'status'] }));
}

/** The line a SIP username belongs to, or null. */
export async function lineOfEndpoint(username) {
  if (!username || typeof username !== 'string') return null;
  const endpoint = await PhoneRegistration.findOne({
    where: { username, mode: 'registrar', kind: 'device' },
    attributes: ['id', 'organisationId'],
  });
  if (!endpoint) return null;
  return Line.findOne({ where: { endpointId: endpoint.id } });
}

/**
 * @param {object} request  the `request` object of POST /agent-db/pbx/resolve
 * @param {object} [opts]   `{ now }`
 * @returns {Promise<object>} a plan. A call that cannot be routed is a plan with `action: 'refuse'`.
 */
export async function resolveRequest(request, opts = {}) {
  switch (request?.kind) {
    case 'number': {
      const number = normalizeE164(String(request.calledNumber ?? ''));
      if (!number || !request.trunkId) throw new PbxError(400, 'bad_request', 'calledNumber and trunkId are required');
      // By number and trunk, with the workers' own lookup.
      const row = await PhoneNumber.findOne({ where: inboundNumberWhere(number, request.trunkId) });
      if (!row) return refusal('number_not_found');
      if (row.extensionId && row.organisationId) {
        return planFor(row.organisationId, { kind: 'extension', extensionId: row.extensionId, callerId: request.callerId, hop: 0 }, opts);
      }
      if (row.instanceId) return agentPlan(row.instanceId, row.organisationId);
      return row.organisationId ? refusal('number_not_routed', row.organisationId) : refusal('number_not_found');
    }
    case 'registration': {
      if (!request.registrationId) throw new PbxError(400, 'bad_request', 'registrationId is required');
      const id = String(request.registrationId);
      const registration = UUID.test(id)
        ? await PhoneRegistration.findByPk(id, { attributes: ['id', 'kind', 'organisationId', 'instanceId', 'trunkId'] })
        : null;
      // A desk phone line is not a registration connection.
      if (!registration || isDeviceLine(registration)) return refusal('registration_not_found');
      // No organisation named, as for the agent refusals: see agentPlan.
      if (await organisationDeactivated(registration.organisationId)) return refusal('organisation_deactivated');
      // The workers' order: the registration's own agent, then the agent of
      // the number called on its trunk. Never a number with no trunk: the
      // request names none, so the trunk is the registration's own.
      const own = registration.instanceId ? await agentPlan(registration.instanceId, registration.organisationId) : null;
      if (own && own.reason !== 'agent_not_available') return own;
      const number = normalizeE164(String(request.calledNumber ?? ''));
      if (registration.trunkId && number) {
        const row = await PhoneNumber.findOne({ where: inboundNumberWhere(number, registration.trunkId) });
        if (row?.instanceId) return agentPlan(row.instanceId, row.organisationId);
      }
      return own ?? refusal('registration_not_routed');
    }
    case 'dialled': {
      if (typeof request.digits !== 'string' || !request.digits.trim()) throw new PbxError(400, 'bad_request', 'digits are required');
      const line = await lineOfEndpoint(request.fromEndpoint);
      if (!line) return refusal('line_not_found');
      return planFor(line.organisationId, { kind: 'dialled', lineId: line.id, digits: request.digits }, opts);
    }
    case 'extension': {
      if (!request.organisationId || !request.extensionId) throw new PbxError(400, 'bad_request', 'organisationId and extensionId are required');
      return planFor(request.organisationId, {
        kind: 'extension',
        extensionId: request.extensionId,
        callerId: request.callerId,
        skip: request.skip,
        hop: request.hop,
      }, opts);
    }
    case 'line': {
      if (!request.organisationId || request.lineNumber == null) throw new PbxError(400, 'bad_request', 'organisationId and lineNumber are required');
      return planFor(request.organisationId, { kind: 'line', lineNumber: request.lineNumber, callerId: request.callerId }, opts);
    }
    default:
      throw new PbxError(400, 'bad_request', 'request.kind must be number, registration, dialled, extension or line');
  }
}
