/**
 * Answers call control's question "what should this call do?". It finds the
 * organisation the request belongs to, loads its directory, and builds the
 * ring plan (lib/pbx/ring-plan.js).
 *
 * The organisation always comes from a row the request names (a number on a
 * trunk, a line's SIP username), never from a bare field, except for the
 * follow-up kinds that call control sends about a call it already holds.
 */
import { randomUUID } from 'node:crypto';
import { PhoneNumber, PhoneRegistration, Line } from '../database.js';
import { normalizeE164 } from '../validation.js';
import { indexSnapshot } from './snapshot.js';
import { loadSnapshot } from './store.js';
import { buildRingPlan, PLAN_TTL_SECONDS } from './ring-plan.js';
import { PbxError } from './errors.js';

const refusal = (reason, organisationId = null) => ({
  planId: `p-${randomUUID()}`,
  ttlSeconds: PLAN_TTL_SECONDS,
  organisationId,
  action: 'refuse',
  reason,
});

async function planFor(organisationId, request, opts) {
  const snapshot = await loadSnapshot(organisationId);
  if (!snapshot) return refusal('organisation_not_found');
  return buildRingPlan(indexSnapshot(snapshot), request, opts);
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
      // By number and trunk, as inbound routing to an agent is.
      const row = await PhoneNumber.findOne({ where: { number, aplisayId: String(request.trunkId) } });
      if (!row || !row.organisationId) return refusal('number_not_found');
      if (!row.extensionId) return refusal('number_not_routed', row.organisationId);
      return planFor(row.organisationId, { kind: 'extension', extensionId: row.extensionId, callerId: request.callerId, hop: 0 }, opts);
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
      throw new PbxError(400, 'bad_request', 'request.kind must be number, dialled, extension or line');
  }
}
