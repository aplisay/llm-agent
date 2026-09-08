import { PhoneRegistration } from '../../../../lib/database.js';
import { userOwnsRow } from '../../../../lib/scope.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { credentialsFor, isRegistrarAccount } from '../../../../lib/registrar-accounts.js';
import { mintRegistrarPassword } from '../../../../lib/utils/credentials.js';

let log;

// Reveal and rotate share this one route file on purpose. A `credentials`
// directory is .gitignored in every Aplisay repository, for literal
// credentials, so a nested `credentials/rotate.js` can never be committed;
// rotation is therefore POST on the same path rather than a sub-route.
export default function (logger) {
  log = logger;
  return {
    GET: revealCredentials,
    POST: rotateCredentials
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
 * Issue a registrar account a new password.
 *
 * The username stays: it is the account's identity on the wire and in the
 * regserver's bindings, and changing it would be a new account. The state goes
 * back to `initial`, which is the one signal the node acts on — it reloads the
 * credential on its next pass and keeps any existing binding until the PBX's
 * next REGISTER, which then fails with 403 until the customer pastes the new
 * password in. Audited like a reveal.
 */
const rotateCredentials = async (req, res) => {
  if (!requirePermission(res, 'phoneEndpoint', 'update')) return;
  const { identifier } = req.params;

  try {
    const registration = await loadRegistrarAccount(identifier, res);
    if (!registration) return;

    const password = mintRegistrarPassword();
    await registration.update({ password, state: 'initial', error: null });

    req.log?.info({
      audit: 'registrar-credentials-rotated',
      registrationId: registration.id,
      organisationId: registration.organisationId,
      userId: res.locals.user?.id
    }, 'registrar account password rotated');

    return res.send(credentialsFor(registration, password));
  }
  catch (err) {
    req.log?.error(err, 'rotating registrar account credentials');
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

rotateCredentials.apiDoc = {
  summary: 'Rotate the password of a registrar account',
  description: `Mints a new password for a registrar account and returns the full credentials once.
                The username is unchanged. The registration state is reset to \`initial\`; the node
                serving the account picks the new password up on its next pass, and the PBX's next
                REGISTER with the old one is refused. Requires phoneEndpoint:update; recorded in the
                audit log.`,
  operationId: 'rotateRegistrarAccountCredentials',
  tags: ['Phone Endpoints'],
  parameters: [
    { name: 'identifier', in: 'path', required: true, schema: { type: 'string' }, description: 'Registration endpoint ID (registrar accounts only)' }
  ],
  responses: {
    200: {
      description: 'The new credentials',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RegistrarAccountCredentials' } } }
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    404: { description: 'Not found, or not a registrar account', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};
