import { PhoneNumber } from '../../../../lib/database.js';
import { authoriseOutboundDestination } from '../../../../lib/outbound-authorisation.js';
import { lineOfEndpoint } from '../../../../lib/pbx/resolve.js';

/**
 * POST /api/agent-db/pbx/outbound-authorisation: call control asks before it
 * places a leg to an outside number. Internal, call control token only.
 *
 * It runs the same policy as the workers' route. The organisation comes from
 * the line that is calling, or from the request for a leg with no line (a
 * mobile rung for a call in). The caller must fail closed when this route
 * cannot be reached.
 */
export default function (logger) {
  const authorise = async (req, res) => {
    const { fromEndpoint, calledId, presentNumber } = req.body || {};
    let { organisationId } = req.body || {};
    try {
      if (!calledId || typeof calledId !== 'string') {
        return res.status(400).send({ error: 'calledId is required' });
      }
      if (fromEndpoint) {
        const line = await lineOfEndpoint(fromEndpoint);
        if (!line) return res.send({ allowed: false, code: 'line_not_found', reason: 'no line has that SIP username' });
        organisationId = line.organisationId;
      }
      if (!organisationId) return res.status(400).send({ error: 'fromEndpoint or organisationId is required' });

      // The leg goes out on the trunk of the number it shows.
      const shown = presentNumber
        ? await PhoneNumber.findOne({
          where: { number: String(presentNumber).replace(/^\+/, ''), organisationId },
          attributes: ['aplisayId'],
        })
        : null;
      const decision = await authoriseOutboundDestination({ calledId, organisationId, aplisayId: shown?.aplisayId || null });
      if (!decision.allowed) {
        logger.info({ calledId, organisationId, code: decision.code, trunkId: decision.trunkId }, 'phone system outbound destination refused');
      }
      return res.send(decision);
    } catch (err) {
      logger.error(err, 'error authorising a phone system outbound destination');
      return res.status(500).send({ error: 'Internal server error' });
    }
  };
  authorise.apiDoc = {
    summary: 'Authorise an outside leg of a phone system call (internal).',
    operationId: 'authorisePbxOutboundDestination',
    tags: ['agent-db'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['calledId'],
            properties: {
              calledId: { type: 'string', description: 'The destination number.' },
              fromEndpoint: { type: 'string', nullable: true, description: 'The SIP username of the line that is calling.' },
              organisationId: { type: 'string', nullable: true, description: 'For a leg with no line. Ignored when fromEndpoint is given.' },
              presentNumber: { type: 'string', nullable: true, description: 'The number the leg will show.' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The decision: `allowed`, and when refused a `code` and a `reason`.', content: { 'application/json': { schema: { type: 'object' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { POST: authorise };
}
