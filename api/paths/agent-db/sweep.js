import { sweepUncostedRows } from '../../../lib/rates.js';

/**
 * POST /api/agent-db/sweep — run the usage-cost reconciliation sweep
 * (lib/rates.js sweepUncostedRows): values finalised rows that are uncosted /
 * no_rate / errored (backfill + retry + re-cost-on-correction). INTERNAL only —
 * /agent-db is gated to the system principal (x-shared-token) by the auth
 * middleware, so a scheduler (cron / Cloud Scheduler) drives it nightly with the
 * shared token. Bounded by `limit` per batch; drains until a batch makes no
 * progress (all remaining rows are stuck no_rate/no_line) or `maxBatches` hit.
 *
 * `dryRun: true` resolves and reports every row WITHOUT writing a cost or moving
 * a balance. A backfill over historical rows settles real money against real
 * organisations, so it has to be previewable before it is run.
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
    const dryRun = req.body?.dryRun === true;
    let scanned = 0;
    let costed = 0;
    let finalised = 0;
    let attributed = 0;
    let batches = 0;
    const byStatus = {};
    for (let i = 0; i < maxBatches; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await sweepUncostedRows({ limit, dryRun, log: req.log || log });
      scanned += r.scanned;
      costed += r.costed;
      finalised += r.finalised;
      attributed += r.attributed;
      for (const [k, v] of Object.entries(r.byStatus || {})) byStatus[k] = (byStatus[k] || 0) + v;
      batches += 1;
      // Stop when a batch is short (backlog drained) or made no progress (the
      // rest are stuck no_rate/no_line — re-running won't change them). A dry
      // run writes nothing, so every batch would return the SAME rows forever:
      // one batch is all a preview can meaningfully do.
      if (dryRun || r.scanned < limit || r.costed === 0) break;
    }
    res.send({ scanned, costed, finalised, attributed, batches, byStatus, dryRun });
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
            maxBatches: { type: 'integer', default: 1, description: 'Max batches to drain this invocation (1–100). Ignored for a dry run, which writes nothing and so would re-scan the same rows forever.' },
            dryRun: { type: 'boolean', default: false, description: 'Resolve and report only — no cost written, no balance moved. Use before any backfill that will settle historical usage.' },
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
              finalised: { type: 'integer', description: 'Abandoned session meters finalised so they became costable at all.' },
              attributed: { type: 'integer', description: 'Rows recovered from a null organisation via their user.' },
              batches: { type: 'integer' },
              byStatus: { type: 'object', description: 'Rows by resulting cost status — what the sweep could and could not value.' },
              dryRun: { type: 'boolean' },
            },
          },
        },
      },
    },
    500: { description: 'Internal error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } } },
  },
};
