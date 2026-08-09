import { Call, TransactionLog, InvocationLog, Organisation, Op, Sequelize } from '../../../lib/database.js';
import { Storage } from '@google-cloud/storage';
import { requirePermission, can } from '../../../lib/auth/permissions.js';
import { parseGcsPath, defaultRecordingBaseUrl } from '../../../lib/recording/index.js';

/**
 * POST /api/calls/prune — org-scoped bulk pruning of stored call ARTIFACTS
 * (recordings / transcripts / invocation logs) older than a cut-off date, so a
 * client system can apply its own retention policies. The call rows themselves
 * (caller, duration, status, billing linkage) are NEVER deleted — pruning only
 * removes the artifacts and nulls the recording metadata columns. `usage_records`
 * and `call_recording_downloads` are never touched.
 *
 * Gated on `call:prune` (superAdmin + the billingService seam). Tenancy: callers
 * are confined to their OWN organisation unless they hold the cross-tenant
 * billing-service seam permission `organisation:billing` (see the
 * /organisations/{id}/billing handler, whose permission "implies cross-tenant
 * service use") — mirroring the balance endpoint's own-org-unless-marker
 * pattern. An out-of-scope organisationId gets a 404, never data (same
 * existence-hiding rule as lib/auth/admin-scope.js).
 *
 * Matching is ARTIFACT-AWARE, which is what makes a drain loop terminate:
 * destroying transcript/invocation rows (and nulling recordingId) does not stop
 * the call row matching a naive `createdAt < before` WHERE, so an already-pruned
 * call would be re-matched forever and `remaining` could never go false. We
 * therefore only select calls where at least one REQUESTED artifact still
 * exists (recordingId NOT NULL, or an EXISTS against the relevant log table);
 * each pass removes those artifacts, the call drops out of the match set, and
 * a second identical request reports `matched: 0, remaining: false`.
 */

// Test seam: unit tests substitute a stub client here; production always uses
// a real GCS client (the same pattern as the per-call recording DELETE).
let makeStorage = () => new Storage();
export function _setStorageFactory(factory) {
  makeStorage = factory || (() => new Storage());
}

const ARTIFACTS = ['recording', 'transcript', 'invocationLog'];

export default function (logger) {
  const pruneCalls = async (req, res) => {
    if (!requirePermission(res, 'call', 'prune')) return;
    const log = req.log || logger;
    const { before, artifacts, limit, organisationId } = req.body || {};

    const beforeDate = typeof before === 'string' ? new Date(before) : null;
    if (!beforeDate || Number.isNaN(beforeDate.valueOf())) {
      return res.status(400).send({ message: 'before must be an ISO date-time string' });
    }

    let wanted = ARTIFACTS;
    if (artifacts !== undefined) {
      if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.some((a) => !ARTIFACTS.includes(a))) {
        return res.status(400).send({ message: `artifacts must be a non-empty array drawn from ${ARTIFACTS.join(', ')}` });
      }
      wanted = [...new Set(artifacts)];
    }

    let batchLimit = 200;
    if (limit !== undefined) {
      if (!Number.isInteger(limit)) {
        return res.status(400).send({ message: 'limit must be an integer' });
      }
      batchLimit = Math.min(Math.max(limit, 1), 500);
    }

    if (organisationId !== undefined && typeof organisationId !== 'string') {
      return res.status(400).send({ message: 'organisationId must be a string' });
    }

    // Tenancy: own org by default; a cross-tenant service caller (the billing
    // seam / system principal) may name any org. Out-of-scope target -> 404.
    const user = res.locals.user;
    const crossTenant = user?.isSystem === true || can(user, 'organisation', 'billing');
    const targetOrgId = organisationId ?? user?.organisationId ?? null;
    if (!targetOrgId) {
      return res.status(400).send({ message: 'organisationId is required when the caller has no organisation' });
    }
    if (!crossTenant && targetOrgId !== user?.organisationId) {
      return res.status(404).send({ message: `Organisation ${targetOrgId} not found` });
    }
    const org = await Organisation.findByPk(targetOrgId);
    if (!org) {
      return res.status(404).send({ message: `Organisation ${targetOrgId} not found` });
    }

    // Only finished calls are ever pruned: never live, and only once an end
    // time has been stamped (an unended row is either in flight or under
    // investigation — leave its artifacts alone).
    // The [Op.or] leg is the artifact-aware match described above.
    const artifactConditions = [];
    if (wanted.includes('recording')) {
      artifactConditions.push({ recordingId: { [Op.ne]: null } });
    }
    if (wanted.includes('transcript')) {
      artifactConditions.push(Sequelize.literal('EXISTS (SELECT 1 FROM transaction_logs WHERE transaction_logs.call_id = "Call"."id")'));
    }
    if (wanted.includes('invocationLog')) {
      artifactConditions.push(Sequelize.literal('EXISTS (SELECT 1 FROM invocation_logs WHERE invocation_logs.call_id = "Call"."id")'));
    }

    const where = {
      [Op.and]: [
        { organisationId: targetOrgId },
        { live: false },
        { endedAt: { [Op.ne]: null } },
        { createdAt: { [Op.lt]: beforeDate } },
        { [Op.or]: artifactConditions },
      ],
    };

    try {
      const calls = await Call.findAll({ where, order: [['createdAt', 'ASC']], limit: batchLimit });

      let prunedRecordings = 0;
      let prunedTranscripts = 0;
      let prunedInvocationLogs = 0;
      const storage = wanted.includes('recording') ? makeStorage() : null;
      const { bucket } = wanted.includes('recording') ? parseGcsPath(defaultRecordingBaseUrl()) : {};

      for (const call of calls) {
        if (wanted.includes('recording') && call.recordingId) {
          const objectName = call.recordingId;
          try {
            // Best-effort object delete, exactly as DELETE /calls/{id}/recording:
            // a missing object is fine, and a storage failure still clears the
            // metadata so the call stops advertising a recording.
            await storage.bucket(bucket).file(objectName).delete({ ignoreNotFound: true });
          } catch (err) {
            log.error({ err, callId: call.id, objectName }, 'prune: error deleting recording object from storage');
          }
          call.recordingId = null;
          call.encryptionKey = null;
          await call.save();
          prunedRecordings += 1;
        }
        if (wanted.includes('transcript')) {
          const n = await TransactionLog.destroy({ where: { callId: call.id } });
          if (n > 0) prunedTranscripts += 1;
        }
        if (wanted.includes('invocationLog')) {
          const n = await InvocationLog.destroy({ where: { callId: call.id } });
          if (n > 0) prunedInvocationLogs += 1;
        }
      }

      return res.send({
        matched: calls.length,
        prunedRecordings,
        prunedTranscripts,
        prunedInvocationLogs,
        // A full batch means there may be more matching calls: the caller
        // loops until remaining is false (guaranteed to happen — see above).
        remaining: calls.length === batchLimit,
      });
    } catch (err) {
      log.error({ err }, 'prune calls failed');
      return res.status(500).send({ error: err.message });
    }
  };

  pruneCalls.apiDoc = {
    summary: 'Bulk-prune stored call artifacts (recordings / transcripts / invocation logs) older than a date.',
    description:
      'Retention seam for client systems: deletes the selected artifacts of finished calls created before `before`, '
      + 'one bounded batch per request. Call rows themselves are never deleted (only the recording metadata columns are '
      + 'nulled), and usage/billing records are untouched. Matching is artifact-aware — only calls that still hold at '
      + 'least one requested artifact are selected — so repeating the request drains to `matched: 0, remaining: false` '
      + 'and the operation is idempotent. Callers are confined to their own organisation unless they hold the '
      + 'cross-tenant billing-service permission.',
    operationId: 'pruneCalls',
    tags: ['Calls'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['before'],
            properties: {
              before: {
                type: 'string',
                format: 'date-time',
                description: 'Prune artifacts of calls created strictly before this instant.',
              },
              artifacts: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', enum: ARTIFACTS },
                description: 'Which artifacts to prune (default: all three).',
              },
              limit: {
                type: 'integer',
                default: 200,
                description: 'Calls to process this batch (clamped 1–500); loop while `remaining` is true.',
              },
              organisationId: {
                type: 'string',
                description: 'Target organisation (cross-tenant service callers only; defaults to the caller’s own organisation).',
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Batch report.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                matched: { type: 'integer', description: 'Calls in this batch that still held a requested artifact.' },
                prunedRecordings: { type: 'integer', description: 'Calls whose recording was deleted.' },
                prunedTranscripts: { type: 'integer', description: 'Calls whose transcript rows were deleted.' },
                prunedInvocationLogs: { type: 'integer', description: 'Calls whose invocation-log rows were deleted.' },
                remaining: { type: 'boolean', description: 'True when the batch was full — call again to continue draining.' },
              },
            },
          },
        },
      },
      400: { description: 'Invalid before / artifacts / limit', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: 'Requires call:prune', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Organisation not found (or out of scope)', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { POST: pruneCalls };
}
