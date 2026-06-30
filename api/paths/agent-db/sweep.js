import { sweepUncostedRows } from '../../../lib/rates.js';

/**
 * POST /api/agent-db/sweep — run the usage-cost reconciliation sweep
 * (lib/rates.js sweepUncostedRows): values finalised rows that are uncosted /
 * no_rate / errored (backfill + retry + re-cost-on-correction). INTERNAL only —
 * /agent-db is gated to the system principal (x-shared-token) by the auth
 * middleware, so a scheduler (cron / Cloud Scheduler) drives it nightly with the
 * shared token. Bounded by `limit` per batch; drains until a batch makes no
 * progress (all remaining rows are stuck no_rate/no_line) or `maxBatches` hit.
 */
let log;

export default function (logger) {
  log = logger;
  return { POST: runSweep };
}

const runSweep = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.body?.limit) || 500, 1), 2000);
    const maxBatches = Math.min(Math.max(Number(req.body?.maxBatches) || 1, 1), 100);
    let scanned = 0;
    let costed = 0;
    let batches = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await sweepUncostedRows({ limit, log: req.log || log });
      scanned += r.scanned;
      costed += r.costed;
      batches += 1;
      // Stop when a batch is short (backlog drained) or made no progress (the
      // rest are stuck no_rate/no_line — re-running won't change them).
      if (r.scanned < limit || r.costed === 0) break;
    }
    res.send({ scanned, costed, batches });
  } catch (err) {
    req.log.error(err, 'rates sweep endpoint failed');
    res.status(500).send({ error: err.message });
  }
};

runSweep.apiDoc = {
  summary: 'Run the usage-cost reconciliation sweep (internal scheduler).',
  description: 'Costs finalised usage rows that are uncosted / no_rate / errored. Internal only '
    + '(x-shared-token / system principal); intended to be driven nightly by a scheduler.',
  operationId: 'runRatesSweep',
  tags: ['Usage'],
  requestBody: {
    required: false,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', default: 500, description: 'Rows per batch (1–2000).' },
            maxBatches: { type: 'integer', default: 1, description: 'Max batches to drain this invocation (1–100).' },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Sweep result.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              scanned: { type: 'integer' },
              costed: { type: 'integer', description: 'Rows that resolved to a matched cost.' },
              batches: { type: 'integer' },
            },
          },
        },
      },
    },
    500: { description: 'Internal error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } } },
  },
};
