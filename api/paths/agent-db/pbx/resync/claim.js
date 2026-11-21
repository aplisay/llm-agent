import { phoneResyncReady } from '../../../../../lib/capabilities.js';
import { claimOrWait, recordResyncResults } from '../../../../../lib/pbx/resync.js';
import { RESYNC_BATCH, RESYNC_MAX_HOLD_SECONDS, RESYNC_STATES } from '../../../../../lib/pbx/resync-rules.js';

/**
 * POST /api/agent-db/pbx/resync/claim: call control takes the desk phones it
 * should tell to fetch their settings. Internal, call control token only.
 *
 * Each phone given here has one ask counted against it, so a caller must act
 * on every phone it is given. `waitSeconds` holds the request open until a
 * phone is due. `results` reports what became of phones taken earlier.
 */
export default function (logger) {
  const claim = async (req, res) => {
    const { limit = RESYNC_BATCH, waitSeconds = 0, results = [] } = req.body || {};
    try {
      if (!phoneResyncReady()) {
        return res.status(503).send({ error: 'The database upgrade for this route has not been applied', code: 'phone_resync_not_ready' });
      }
      const recorded = await recordResyncResults(results);
      let gone = false;
      res.on('close', () => { gone = true; });
      const phones = await claimOrWait({ limit, waitMs: waitSeconds * 1000, gone: () => gone, log: req.log || logger });
      if (phones.length) (req.log || logger).info({ phones: phones.length, recorded }, 'phone resync: phones given to call control');
      return res.send({ phones });
    } catch (err) {
      logger.error(err, 'error giving call control the phones to tell');
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
  claim.apiDoc = {
    summary: 'Take the desk phones that should be told to fetch their settings (internal).',
    description: 'A phone is given when its settings changed after it last fetched: at once, and again after 1, 5, 15 and '
      + '60 minutes and 6 hours while it has not fetched, six times in all for one version. Never twice within 10 seconds. '
      + 'A phone is given to one caller only. The same `configVersion` is given again with a higher `attempt`, and the '
      + 'caller must tell the phone each time. Answers 503 `phone_resync_not_ready` before the database upgrade.',
    operationId: 'claimPbxPhoneResyncs',
    tags: ['agent-db'],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              limit: { type: 'integer', minimum: 0, maximum: RESYNC_BATCH, description: 'The most phones to take. 0 takes none, to report only. Default 100.' },
              waitSeconds: {
                type: 'integer',
                minimum: 0,
                maximum: RESYNC_MAX_HOLD_SECONDS,
                description: 'Hold the request open this long while no phone is due. Default 0. A request over the limit '
                  + 'of held requests for one API process is answered at once.',
              },
              results: {
                type: 'array',
                maxItems: 500,
                description: 'What became of phones taken earlier. Kept for the phone\'s page only, and only while that ask is the phone\'s latest.',
                items: {
                  type: 'object',
                  required: ['deviceId', 'configVersion', 'attempt', 'state'],
                  properties: {
                    deviceId: { type: 'string', format: 'uuid' },
                    configVersion: { type: 'integer' },
                    attempt: { type: 'integer' },
                    state: { type: 'string', enum: RESYNC_STATES },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The phones taken, which may be none.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                phones: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      deviceId: { type: 'string' },
                      phoneId: { type: 'string' },
                      organisationId: { type: 'string' },
                      configVersion: { type: 'integer' },
                      attempt: { type: 'integer', description: 'Which ask this is for the version, from 1.' },
                      action: { type: 'string', description: 'Always `check-sync`.' },
                      lines: { type: 'array', items: { type: 'string' }, description: 'The SIP usernames of the phone\'s lines, in key order.' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { POST: claim };
}
