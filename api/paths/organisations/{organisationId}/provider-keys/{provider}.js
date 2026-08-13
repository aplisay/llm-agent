import { Organisation, OrganisationKey } from '../../../../../lib/database.js';
import { requirePermission } from '../../../../../lib/auth/permissions.js';
import { targetInScope } from '../../../../../lib/auth/admin-scope.js';
import { isKnownProvider } from '../../../../../lib/utils/provider-keys.js';

/**
 * /api/organisations/{organisationId}/provider-keys/{provider} — one BYOK key
 * (docs/byok.md).
 *   PUT    upsert the key for a provider slug. Fail-closed: when
 *          CREDENTIALS_KEY is unavailable the write is refused (500) and
 *          NOTHING is stored — never plaintext. Responds with the masking
 *          hint only, never the value.
 *   DELETE remove the stored key (platform keys apply again from the next
 *          call); 404 when none is stored.
 *
 * Same `organisation:providerKeys` + targetInScope gates as the listing.
 */
export default function (logger) {
  // The org row, or null after sending the 404/403 — shared by both verbs.
  const gate = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'providerKeys')) return null;
    const org = await Organisation.findByPk(req.params.organisationId);
    if (!org || !targetInScope(res.locals.user, 'organisation', org)) {
      res.status(404).send({ message: `Organisation ${req.params.organisationId} not found` });
      return null;
    }
    return org;
  };

  const put = async (req, res) => {
    const org = await gate(req, res);
    if (!org) return;
    const { provider } = req.params;
    // Validated in-handler (not left to express-openapi): unknown slugs and
    // malformed bodies must 400 on every entry path.
    if (!isKnownProvider(provider)) {
      return res.status(400).send({ message: `Unknown provider ${provider}` });
    }
    const { value } = req.body || {};
    if (typeof value !== 'string' || !value.length) {
      return res.status(400).send({ message: 'value must be a non-empty string' });
    }
    const hint = value.slice(-4);
    try {
      const existing = await OrganisationKey.findOne({ where: { organisationId: org.id, provider } });
      if (existing) {
        // The value setter encrypts strictly — it throws (before any save)
        // when CREDENTIALS_KEY is unavailable.
        existing.value = value;
        existing.hint = hint;
        await existing.save();
      } else {
        await OrganisationKey.create({ organisationId: org.id, provider, value, hint });
      }
    } catch (err) {
      // Never log or echo the submitted value.
      logger.error({ err: err?.message, provider, organisationId: org.id }, 'storing organisation provider key');
      return res.status(500).send({ message: err?.message || 'Failed to store provider key' });
    }
    return res.send({ provider, hint });
  };
  put.apiDoc = {
    summary: 'Store (upsert) an organisation’s BYOK key for a provider. Write-only: the value is never returned.',
    operationId: 'upsertOrganisationProviderKey',
    tags: ['Organisations'],
    parameters: [
      { in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } },
      { in: 'path', name: 'provider', required: true, schema: { type: 'string' }, description: 'Canonical provider slug (see the listing’s `providers` catalogue)' },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['value'],
            properties: {
              value: { type: 'string', minLength: 1, description: 'The provider API key (stored encrypted; write-only)' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Stored',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                hint: { type: 'string', description: 'Last 4 characters of the stored key' },
              },
            },
          },
        },
      },
      400: { description: 'Unknown provider or invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      500: { description: 'Encryption unavailable (CREDENTIALS_KEY unset) — nothing stored', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const del = async (req, res) => {
    const org = await gate(req, res);
    if (!org) return;
    const { provider } = req.params;
    const deleted = await OrganisationKey.destroy({ where: { organisationId: org.id, provider } });
    if (!deleted) {
      return res.status(404).send({ message: `No ${provider} key stored for organisation ${org.id}` });
    }
    return res.status(204).send();
  };
  del.apiDoc = {
    summary: 'Delete an organisation’s BYOK key for a provider (platform keys apply again from the next call).',
    operationId: 'deleteOrganisationProviderKey',
    tags: ['Organisations'],
    parameters: [
      { in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } },
      { in: 'path', name: 'provider', required: true, schema: { type: 'string' } },
    ],
    responses: {
      204: { description: 'Deleted' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { PUT: put, DELETE: del };
}
