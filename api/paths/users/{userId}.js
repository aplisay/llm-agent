import { User, Organisation } from '../../../lib/database.js';
import { requirePermission, can, actorCanGrant, validateRbacFields } from '../../../lib/auth/permissions.js';
import { targetInScope } from '../../../lib/auth/admin-scope.js';

/**
 * /api/users/{userId} (item) — RBAC-gated (`user:*`), org-scoped.
 *   GET    fetch a user (orgAdmin: own org only).
 *   PATCH  accept/activate (status), and edit role / agentLimit / name /
 *          `status` is the soft-delete lever (DELETE sets status='deactivated'), so
 *          ANY cross-tenant status change requires the same `user:delete` capability
 *          as DELETE — with one exemption, the onboarding accept seam
 *          (`provisional` -> `active`). Re-activating an already suspended/deactivated
 *          user is NOT exempt: it reverses an admin action. A `user:readAll` principal
 *          counts as cross-tenant by definition (it can move the target into its own
 *          org via `organisationId` on this same route); orgAdmin editing their OWN
 *          org's users is unaffected.
 *          permissions / allowedModels / organisationId / emailVerified.
 *          `emailVerified` asserts address ownership (equivalent to what better-auth
 *          writes on a proven emailed link), so it needs the cross-tenant `user:readAll`
 *          and can never be set on the actor's own user. Cross-tenant edits
 *          (granting a cross-tenant role/permission, or moving a user to another
 *          org) require the cross-tenant `user:readAll` (superAdmin).
 *   DELETE soft-deactivate (status='deactivated'); superAdmin only (`user:delete`).
 *          orgAdmin deactivates a user via PATCH { status:'deactivated' } instead.
 *
 * Out-of-scope targets return 404 (not 403) so existence isn't leaked across tenants.
 * This route must stay GET/PATCH/DELETE only — the POST-only signup sibling
 * (/api/users/signup) relies on there being no POST here.
 */
const EDITABLE = ['status', 'role', 'agentLimit', 'name', 'permissions', 'allowedModels', 'organisationId', 'emailVerified'];
const VALID_ROLES = ['owner', 'member', 'textOnly', 'audioOnly', 'support', 'orgAdmin', 'superAdmin'];

export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'user', 'read')) return;
    const u = await User.findByPk(req.params.userId, { include: [{ model: Organisation, attributes: ['id', 'name'], required: false }] });
    if (!u || !targetInScope(res.locals.user, 'user', u)) {
      return res.status(404).send({ message: `User ${req.params.userId} not found` });
    }
    return res.send(u);
  };
  get.apiDoc = {
    summary: 'Get a user (admin).',
    operationId: 'getUser',
    tags: ['Users'],
    parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'User' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const update = async (req, res) => {
    if (!requirePermission(res, 'user', 'update')) return;
    const u = await User.findByPk(req.params.userId);
    if (!u || !targetInScope(res.locals.user, 'user', u)) {
      return res.status(404).send({ message: `User ${req.params.userId} not found` });
    }
    const actorReadAll = can(res.locals.user, 'user', 'readAll');
    const isSelf = req.params.userId === res.locals.user.id;

    // Self-protection: an admin may not edit their OWN role/permissions/status/org/
    // allowedModels via this route (prevents self-escalation — incl. self-widening
    // their own model allow-list past an admin-set restriction). Bootstrap
    // super-admins are env-driven so this never locks them out; name/agentLimit
    // self-edits are fine.
    if (isSelf && ['role', 'permissions', 'status', 'organisationId', 'allowedModels', 'emailVerified'].some((k) => k in req.body)) {
      return res.status(403).json({ message: 'forbidden', detail: 'You cannot change your own role, permissions, status, organisation, model access, or email verification.' });
    }

    // Per-field capability guards.
    if ('role' in req.body) {
      if (!can(res.locals.user, 'user', 'setRole')) return res.status(403).json({ message: 'forbidden', detail: 'Requires user:setRole' });
      if (!VALID_ROLES.includes(req.body.role)) return res.status(400).send({ message: `Unknown role '${req.body.role}'.` });
    }
    if (('permissions' in req.body || 'allowedModels' in req.body) && !can(res.locals.user, 'user', 'setPermissions')) {
      return res.status(403).json({ message: 'forbidden', detail: 'Requires user:setPermissions' });
    }
    if ('agentLimit' in req.body && !can(res.locals.user, 'user', 'setLimits')) {
      return res.status(403).json({ message: 'forbidden', detail: 'Requires user:setLimits' });
    }
    if ('organisationId' in req.body && !actorReadAll) {
      return res.status(403).json({ message: 'forbidden', detail: 'Only a super admin may move a user between organisations.' });
    }
    // Marking an address verified is an identity assertion: cross-tenant privilege only
    // (superAdmin / onboardingService), and never on your own user (see self-guard above).
    if ('emailVerified' in req.body && !actorReadAll) {
      return res.status(403).json({ message: 'forbidden', detail: 'Requires user:readAll' });
    }
    // `status` is a lifecycle lever: DELETE soft-deletes by setting
    // status='deactivated', so a principal changing SOMEONE ELSE'S tenant's user
    // must hold the same capability as DELETE (`user:delete`).
    //
    // "Cross-tenant" cannot be decided from the target's CURRENT organisationId alone:
    // `organisationId` is itself editable on this very route under `user:readAll`, so a
    // readAll+update principal could move the user into its own org and then deactivate
    // it as an "own-org" edit. A `user:readAll` principal is therefore cross-tenant by
    // definition (and an `organisationId` in the same body counts too); only a
    // tenant-confined admin (orgAdmin) gets the own-org path.
    const statusCrossTenant = actorReadAll
      || 'organisationId' in req.body
      || u.organisationId == null
      || u.organisationId !== res.locals.user?.organisationId;
    if ('status' in req.body && statusCrossTenant) {
      // The ONLY cross-tenant status transition that isn't a privilege move is the
      // onboarding accept seam: lifting a `provisional` user to `active`. Anything
      // else — suspending, deactivating, or RE-activating a user an admin has already
      // suspended/deactivated (reversing the #215 soft-delete) — needs `user:delete`.
      const acceptSeam = req.body.status === 'active' && u.status === 'provisional';
      if (!acceptSeam && !can(res.locals.user, 'user', 'delete')) {
        return res.status(403).json({ message: 'forbidden', detail: 'Requires user:delete to change status cross-tenant' });
      }
    }
    // An admin may only grant a role/permission set within their OWN effective perms
    // — blocks cross-tenant readAll AND intra-tenant capability escalation by proxy.
    if (('role' in req.body || 'permissions' in req.body)
        && !actorCanGrant(res.locals.user, { role: req.body.role, permissions: req.body.permissions })) {
      return res.status(403).json({ message: 'forbidden', detail: 'You may only grant capabilities you hold.' });
    }

    const rbacErr = validateRbacFields(req.body);
    if (rbacErr) return res.status(400).send({ message: rbacErr });

    for (const k of EDITABLE) if (k in req.body) u[k] = req.body[k]; // e.g. { status: 'active' } == ACCEPT
    try {
      await u.save();
      // Accepting a (self-signup) user also activates their PROVISIONAL org so the
      // org-status gate doesn't immediately re-block the freshly-accepted user.
      // It is an ORGANISATION mutation, so it is gated as one: the actor must hold
      // `organisation:update` AND have the org in tenancy scope (own org, or
      // `organisation:readAll`). Without that we simply skip the side-effect — the
      // user edit itself was legitimate, so this is a no-op, not a 403.
      //
      // RECORDED DECISION (#216, deliberate divergence): the DIRECT route
      // PATCH /api/organisations/{organisationId} requires `organisation:delete` for
      // ANY cross-tenant status change, including -> active. This seam is gated on the
      // weaker `organisation:update` on purpose, because `onboardingService` holds
      // organisation:['create','read','readAll','update'] and NOT `delete`; requiring
      // `delete` here would break self-signup acceptance. The exposure is bounded to
      // exactly the transition onboarding needs — `provisional` -> `active` on the org
      // of a user being accepted — and can never suspend or deactivate an org. So the
      // #216 invariant holds in the strong form for org DEACTIVATION everywhere, and in
      // this weaker form only for provisional-org activation. Closing the gap fully
      // means giving onboardingService its own capability; out of scope here.
      if (req.body.status === 'active' && u.organisationId) {
        const actor = res.locals.user;
        const org = await Organisation.findByPk(u.organisationId);
        if (org && org.status === 'provisional') {
          if (can(actor, 'organisation', 'update') && targetInScope(actor, 'organisation', org)) {
            org.status = 'active';
            await org.save();
          } else {
            logger.warn({ userId: u.id, organisationId: org.id },
              'skipped provisional-org activation: actor lacks organisation:update in scope');
          }
        }
      }
      return res.send(u);
    } catch (err) {
      logger.error({ err: err?.message }, 'updating user');
      return res.status(400).send({ message: err?.message || 'Failed to update user' });
    }
  };
  update.apiDoc = {
    summary: 'Modify a user (admin): accept/activate, set role, agentLimit, name, permissions, allowedModels, organisation, emailVerified.',
    operationId: 'updateUser',
    tags: ['Users'],
    parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['provisional', 'active', 'suspended', 'deactivated'] },
              role: { type: 'string', enum: VALID_ROLES },
              agentLimit: { type: 'integer', nullable: true },
              name: { type: 'string' },
              permissions: { type: 'object', nullable: true },
              allowedModels: { type: 'array', items: { type: 'string' }, nullable: true },
              organisationId: { type: 'string', nullable: true },
              emailVerified: { type: 'boolean' },
            },
            required: [],
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated user' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const del = async (req, res) => {
    if (!requirePermission(res, 'user', 'delete')) return;
    const u = await User.findByPk(req.params.userId);
    if (!u || !targetInScope(res.locals.user, 'user', u)) {
      return res.status(404).send({ message: `User ${req.params.userId} not found` });
    }
    // Soft-delete: deactivate rather than destroy (FK'd data elsewhere).
    u.status = 'deactivated';
    await u.save();
    return res.status(200).send();
  };
  del.apiDoc = {
    summary: 'Deactivate a user (super admin, soft delete).',
    operationId: 'deactivateUser',
    tags: ['Users'],
    parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Deactivated' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PATCH: update, DELETE: del };
}
