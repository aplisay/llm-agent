import { Organisation } from '../../../../lib/database.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { isSafeCallbackUrl } from '../../../../lib/balance-callback.js';

/**
 * /api/organisations/{id}/billing — the org's billing CONTROLS (not money):
 *   GET    read `billingBlocked` + `billingConfig` + `chargeableNumberLimit`.
 *   PATCH  set any of them. `billingConfig` is validated whole (callbackUrl must
 *          pass the SSRF guard, hashKey ≥ 16 chars, balanceLowPennies ≥ 0) or
 *          cleared with null; `billingBlocked` is the hard call-refusal lever
 *          that Call.start() enforces; `chargeableNumberLimit` is the generic
 *          spend-policy cap on numbers held on chargeable (non-owned) trunks
 *          (null = unlimited) that a client billing service sets alongside the
 *          rest of the billing config — the direct org-PATCH route keeps its
 *          own stricter `organisation:setRate` gate for this field.
 *
 * Gated on `organisation:billing` — held by superAdmin and the least-privilege
 * `billingService` role (the client billing system's server-side seam, like
 * `credit`). The
 * permission implies cross-tenant service use, so like the credit endpoint this
 * does no tenancy scoping.
 */
export default function (logger) {
  const shape = (org) => ({
    billingBlocked: !!org.billingBlocked,
    billingConfig: org.billingConfig ?? null,
    chargeableNumberLimit: org.chargeableNumberLimit ?? null,
  });

  const get = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'billing')) return;
    const org = await Organisation.findByPk(req.params.organisationId);
    if (!org) return res.status(404).send({ message: `Organisation ${req.params.organisationId} not found` });
    return res.send(shape(org));
  };
  get.apiDoc = {
    summary: 'Read an organisation’s billing controls (block flag + balance callbacks).',
    operationId: 'getOrganisationBilling',
    tags: ['Organisations', 'Billing'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Billing controls' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const update = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'billing')) return;
    const org = await Organisation.findByPk(req.params.organisationId);
    if (!org) return res.status(404).send({ message: `Organisation ${req.params.organisationId} not found` });

    const body = req.body || {};
    if (!('billingBlocked' in body) && !('billingConfig' in body) && !('chargeableNumberLimit' in body)) {
      return res.status(400).send({ message: 'Provide billingBlocked, billingConfig and/or chargeableNumberLimit' });
    }

    if ('chargeableNumberLimit' in body) {
      const limit = body.chargeableNumberLimit;
      if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
        return res.status(400).send({ message: 'chargeableNumberLimit must be a non-negative integer or null (unlimited)' });
      }
      org.chargeableNumberLimit = limit;
    }

    if ('billingBlocked' in body) {
      if (typeof body.billingBlocked !== 'boolean') {
        return res.status(400).send({ message: 'billingBlocked must be a boolean' });
      }
      org.billingBlocked = body.billingBlocked;
    }

    if ('billingConfig' in body) {
      const cfg = body.billingConfig;
      if (cfg === null) {
        org.billingConfig = null;
      } else {
        if (typeof cfg !== 'object' || Array.isArray(cfg)) {
          return res.status(400).send({ message: 'billingConfig must be an object or null' });
        }
        const { callbackUrl, hashKey, balanceLowPennies = null } = cfg;
        if (typeof callbackUrl !== 'string' || !isSafeCallbackUrl(callbackUrl)) {
          return res.status(400).send({ message: 'billingConfig.callbackUrl must be a safe public http(s) URL' });
        }
        if (typeof hashKey !== 'string' || hashKey.length < 16) {
          return res.status(400).send({ message: 'billingConfig.hashKey must be a string of at least 16 characters' });
        }
        if (balanceLowPennies !== null && (!Number.isFinite(Number(balanceLowPennies)) || Number(balanceLowPennies) < 0)) {
          return res.status(400).send({ message: 'billingConfig.balanceLowPennies must be a non-negative number or null' });
        }
        // Whole-value replace with exactly the known keys — nothing extra rides along.
        org.billingConfig = { callbackUrl, hashKey, balanceLowPennies: balanceLowPennies === null ? null : Number(balanceLowPennies) };
      }
    }

    try {
      await org.save();
    } catch (err) {
      logger.error({ err: err?.message }, 'updating organisation billing controls');
      return res.status(400).send({ message: err?.message || 'Failed to update billing controls' });
    }
    return res.send(shape(org));
  };
  update.apiDoc = {
    summary: 'Set an organisation’s billing controls (billingBlocked / billingConfig / chargeableNumberLimit).',
    operationId: 'updateOrganisationBilling',
    tags: ['Organisations', 'Billing'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              billingBlocked: { type: 'boolean', description: 'Hard block: Call.start() refuses new calls while true.' },
              billingConfig: {
                description: 'Balance-callback config, or null to clear.',
                nullable: true,
                type: 'object',
                properties: {
                  callbackUrl: { type: 'string', description: 'HMAC-signed balanceLow/balanceNegative POST target (public http(s)).' },
                  hashKey: { type: 'string', description: 'Shared HMAC secret (≥ 16 chars).' },
                  balanceLowPennies: { type: 'number', nullable: true, description: 'Low-balance threshold in pennies (null = no balanceLow events).' },
                },
              },
              chargeableNumberLimit: {
                type: 'integer',
                nullable: true,
                minimum: 0,
                description: 'Spend-policy cap: max numbers the org may hold on chargeable (non-owned) trunks; null = unlimited. A client billing service sets this alongside the other billing controls.',
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The updated billing controls' },
      400: { description: 'Invalid', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
    },
  };

  return { GET: get, PATCH: update };
}
