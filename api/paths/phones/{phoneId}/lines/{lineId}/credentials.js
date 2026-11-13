import { Line, Phone, PhoneRegistration } from '../../../../../../lib/database.js';
import { REGISTRAR_PORT, REGISTRAR_TRANSPORT } from '../../../../../../lib/registrar-accounts.js';
import { directoryContext, attempt, sendNotFound } from '../../../../../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, pathId, errorResponses } from '../../../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const get = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'provision', { gate: true });
    if (!ctx) return;
    const organisationId = ctx.organisation.id;
    const phone = await Phone.findOne({ where: { id: req.params.phoneId, organisationId, removedAt: null }, attributes: ['id'] });
    const line = phone && await Line.findOne({ where: { id: req.params.lineId, phoneId: phone.id, organisationId } });
    const endpoint = line?.endpointId ? await PhoneRegistration.findByPk(line.endpointId) : null;
    if (!endpoint || endpoint.organisationId !== organisationId) return sendNotFound(res, 'Line not found');
    // An audit line for every reveal. Never the values.
    (req.log || logger).info({
      audit: 'phone-line-credentials-revealed',
      lineId: line.id,
      phoneId: phone.id,
      organisationId,
      userId: res.locals.user?.id,
    }, 'phone line credentials revealed');
    res.send({
      lineId: line.id,
      lineNumber: line.lineNumber,
      registrar: endpoint.registrar,
      port: REGISTRAR_PORT,
      transport: REGISTRAR_TRANSPORT,
      username: endpoint.username,
      password: endpoint.password,
      ha1: endpoint.ha1,
    });
  });
  get.apiDoc = {
    summary: "Show the SIP account of one line, to set a phone up by hand.",
    description: 'Needs `phone:provision`. Each read is written to the audit log. `ha1` is the digest hash a phone can be '
      + 'given in place of the password.',
    operationId: 'getPhoneLineCredentials',
    tags: [PHONES_TAG],
    parameters: [pathId('phoneId', 'The id of the phone.'), pathId('lineId', 'The id of the line.'), organisationIdQuery],
    responses: {
      200: {
        description: 'The account',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                lineId: { type: 'string' },
                lineNumber: { type: 'integer' },
                registrar: { type: 'string' },
                port: { type: 'integer' },
                transport: { type: 'string' },
                username: { type: 'string' },
                password: { type: 'string' },
                ha1: { type: 'string' },
              },
            },
          },
        },
      },
      ...errorResponses,
    },
  };
  return { GET: get };
}
