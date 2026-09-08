import { requirePermission } from '../../../../../lib/auth/permissions.js';
import { mintRegistrarPassword } from '../../../../../lib/utils/credentials.js';
import { credentialsFor } from '../../../../../lib/registrar-accounts.js';
import { loadRegistrarAccount } from '../credentials.js';

let log;

export default function (logger) {
  log = logger;
  return {
    POST: rotateCredentials
  };
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
