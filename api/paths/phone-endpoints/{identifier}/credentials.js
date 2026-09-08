import { PhoneRegistration } from '../../../../lib/database.js';
import { userOwnsRow } from '../../../../lib/scope.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { credentialsFor, isRegistrarAccount } from '../../../../lib/registrar-accounts.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: revealCredentials
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a customer types into their PBX for a registrar account: the name to
 * register to, the port and transport, and the minted username and password.
 *
 * The create response showed the password once. This is the only other place
 * it is readable, and it is deliberately not the endpoint's ordinary GET: a
 * listing or an edit drawer should not carry a live credential on every render.
 * Gated on phoneEndpoint:update — whoever may set a line's password may read an
 * account's — and every reveal is written to the log as an audit line naming
 * the user and the row.
 */
const revealCredentials = async (req, res) => {
  if (!requirePermission(res, 'phoneEndpoint', 'update')) return;
  const { identifier } = req.params;

  try {
    const registration = await loadRegistrarAccount(identifier, res);
    if (!registration) return;

    req.log?.info({
      audit: 'registrar-credentials-revealed',
      registrationId: registration.id,
      organisationId: registration.organisationId,
      userId: res.locals.user?.id
    }, 'registrar account credentials revealed');

    return res.send(credentialsFor(registration));
  }
  catch (err) {
    req.log?.error(err, 'revealing registrar account credentials');
    return res.status(500).send({ error: 'Internal server error' });
  }
};

/**
 * The registrar account named by the path, or null after answering the
 * request: a phone number, an unknown id, another organisation's row, or a
 * client-mode line (which has no platform-issued credentials to show) are each
 * refused with the status that says which.
 */
export async function loadRegistrarAccount(identifier, res) {
  if (!identifier || identifier.match(/^\+?[0-9]+$/)) {
    res.status(400).send({ error: 'Identifier must be a registration ID, not a phone number' });
    return null;
  }
  if (!UUID.test(identifier)) {
    res.status(404).send({ error: 'Phone endpoint not found' });
    return null;
  }
  const registration = await PhoneRegistration.findByPk(identifier);
  if (!registration) {
    res.status(404).send({ error: 'Phone endpoint not found' });
    return null;
  }
  if (!userOwnsRow(res.locals.user, registration)) {
    res.status(403).send({ error: 'Access denied' });
    return null;
  }
  if (!isRegistrarAccount(registration)) {
    res.status(404).send({
      error: 'This registration is a client-mode line, not a registrar account; its credentials are the ones you supplied',
      code: 'not_registrar_account'
    });
    return null;
  }
  return registration;
}

revealCredentials.apiDoc = {
  summary: 'Reveal the credentials of a registrar account',
  description: `The name, port, transport, username and password a customer enters into their PBX
                for a registrar account (a phone registration created with \`mode: registrar\`).
                The password was returned once when the account was created; this route is the only
                other place it can be read. Requires phoneEndpoint:update, and every call is recorded
                in the audit log. 404 for a client-mode registration, whose credentials are the
                customer's own.`,
  operationId: 'revealRegistrarAccountCredentials',
  tags: ['Phone Endpoints'],
  parameters: [
    { name: 'identifier', in: 'path', required: true, schema: { type: 'string' }, description: 'Registration endpoint ID (registrar accounts only)' }
  ],
  responses: {
    200: {
      description: 'The account credentials',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RegistrarAccountCredentials' } } }
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    404: { description: 'Not found, or not a registrar account', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};
