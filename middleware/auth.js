import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { Instance, User, AuthKey, Organisation } from '../lib/database.js';
import { scopeWhereForUser } from '../lib/scope.js';
import * as firebase from 'firebase-admin/auth';
import { auth as betterAuth } from '../lib/auth/index.js';
import { fromNodeHeaders } from 'better-auth/node';
import { effectivePermissions, statementsFor, intersectStatements, keyRestrictionStatements, can, ORGANISATION_RBAC_ATTRIBUTES } from '../lib/auth/permissions.js';
import { effectiveAllowedModels } from '../lib/auth/model-access.js';
import { isBootstrapSuperAdmin } from '../lib/admin-gate.js';
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time token comparison, for a secret presented by an untrusted
 * caller. Length is compared first because timingSafeEqual throws on a length
 * mismatch rather than returning false.
 */
function tokensMatch(presented, expected) {
  const a = Buffer.from(String(presented), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const BA_SESSION_TTL_MS = 60_000;
const BA_SESSION_MAX = 5000;
const baSessionCache = new Map(); // token -> { user, exp }

function getCachedBaUser(token) {
  const hit = baSessionCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;
  if (hit) baSessionCache.delete(token);
  return null;
}
function setCachedBaUser(token, user) {
  if (baSessionCache.size >= BA_SESSION_MAX) {
    const now = Date.now();
    for (const [k, v] of baSessionCache) if (v.exp <= now) baSessionCache.delete(k);
    if (baSessionCache.size >= BA_SESSION_MAX) baSessionCache.delete(baSessionCache.keys().next().value);
  }
  baSessionCache.set(token, { user, exp: Date.now() + BA_SESSION_TTL_MS });
}

// Provisional gate: a loaded HUMAN principal (better-auth or Firebase) must be
// status==='active' to perform API operations. provisional/suspended/deactivated
// — or a status-less row we couldn't load — is blocked fail-CLOSED with a 403
// `account_pending`. System (x-shared-token), instance join tokens, and AuthKey
// principals never reach this gate: their branches call next() earlier.
function isActive(user) {
  const status = (user && typeof user.get === 'function') ? user.get('status') : user?.status;
  return status === 'active';
}
// A user WITH an organisationId must have a loaded, ACTIVE org. Fail-closed: a
// missing org row (load failed / dangling FK) blocks. Org-less users are unbound.
function orgStatusActive(user) {
  if (!user || user.organisationId == null) return true;
  const org = user.Organisation;
  if (!org) return false;
  const status = (typeof org.get === 'function') ? org.get('status') : org.status;
  return status === 'active';
}

// Account gate: a loaded HUMAN/AuthKey principal must be status==='active' AND
// (unless cross-tenant) belong to an active organisation. Blocks fail-CLOSED.
function gateAccount(res) {
  const u = res.locals.user;
  if (!isActive(u)) {
    res.status(403).json({ message: 'account_pending', detail: 'Your account is awaiting activation.' });
    return false;
  }
  // Cross-tenant principals (super/support/bootstrap) are not bound to an org's status.
  if (!can(u, 'organisation', 'readAll') && !orgStatusActive(u)) {
    res.status(403).json({ message: 'organisation_inactive', detail: 'Your organisation is not active.' });
    return false;
  }
  return true;
}

// Resolve and memoise a principal's RBAC state once per request (R1/R2):
//   user._effectivePermissions = org baseline ∪ user grants  (lib/auth/permissions.js)
//   user._allowedModels        = unioned model-prefix allow-list, null = unrestricted
// The organisation row is eager-loaded when not already attached. Bootstrap
// super-admins (ADMIN_USER_IDS / x-shared-token) get full perms regardless of
// stored role, so the first super admin exists before any role is assigned.
// Mutates and returns `user`. Resolved values ride the BA/AuthKey caches, so an
// org/role change lags up to the cache TTL (~60s) — the accepted trade.
async function attachRbac(user) {
  if (!user || user.isSystem) return user;
  if (isBootstrapSuperAdmin(user)) {
    user._effectivePermissions = statementsFor('superAdmin');
    user._allowedModels = null;
    return user;
  }
  if (user.organisationId && !user.Organisation) {
    try {
      user.Organisation = await Organisation.findByPk(user.organisationId, {
        attributes: ORGANISATION_RBAC_ATTRIBUTES,
      });
    } catch (e) {
      // FAIL CLOSED: never proceed with user-only perms (which would silently drop
      // org-level allowedModels / permission restrictions). Reject the request.
      throw new Error('Failed to load organisation for RBAC');
    }
  }
  user._effectivePermissions = effectivePermissions(user, user.Organisation);
  user._allowedModels = effectiveAllowedModels(user, user.Organisation);
  // AuthKey principals: a key can never exceed its owner — intersect its effective
  // perms with the key's roleRestriction (§4.6). null/empty/legacy => no change.
  const keyRestriction = keyRestrictionStatements(user._roleRestriction);
  if (keyRestriction) user._effectivePermissions = intersectStatements(user._effectivePermissions, keyRestriction);
  return user;
}

function init(app, logger) {

  try {
    const authAdmin = initializeApp({
      credential: applicationDefault(),
      databaseURL: `https://${process.env.GOOGLE_PROJECT_ID}`
    });
  }
  catch (e) {
    logger.error({ e }, 'firebase auth error');
  };

  // Install a route that looks for an access token and tries to work out what sort of token it is

  app.use(async (req, res, next) => {
    if (
      req.method === 'OPTIONS'
      || req.originalUrl.startsWith('/api/api-docs') 
      || req.originalUrl.startsWith('/api/hooks')
      || req.originalUrl.startsWith('/api/auth')
      || req.originalUrl.startsWith('/api/users/signup')
     ) {
      next();
      return;
    }

    // agent-db routes are internal-only: they must be called with x-shared-token.
    // Tenant auth (Firebase / AuthKey) must never be able to access these routes.
    const isAgentDbPath = req.originalUrl.startsWith('/api/agent-db');
    
    // A b2bua node announcing itself needs exactly one route, and it runs on
    // the most exposed machines in the estate — internet-facing SIP, reachable
    // from any address the firewall admits. Handing it SHARED_API_TOKEN, which
    // the check below accepts on *every* route and turns into a full system
    // principal, would mean that compromising one SIP node yields complete
    // internal-API control including stored credentials and super-admin
    // permissions. So the heartbeat gets its own token, scoped to its own route
    // and nothing else — not even reading the fleet list back.
    //
    // SHARED_API_TOKEN still works here, so nodes can be moved onto the scoped
    // token without a coordinated deploy; drop it from the node bundles once
    // they all carry B2BUA_HEARTBEAT_TOKEN.
    const heartbeatToken = process.env.B2BUA_HEARTBEAT_TOKEN;
    const presentedToken = req.headers['x-shared-token'];
    if (heartbeatToken && presentedToken && tokensMatch(presentedToken, heartbeatToken)) {
      if (!req.originalUrl.startsWith('/api/agent-db/b2bua-nodes')) {
        res.status(403).json({ message: 'Forbidden: this token is scoped to the b2bua node heartbeat' });
        return;
      }
      res.locals.user = {
        id: 'b2bua-node',
        user_id: 'b2bua-node',
        name: 'b2bua node (heartbeat)',
        isB2buaNode: true
      };
      res.locals.user.sql = { where: { userId: 'system' } };
      next();
      return;
    }

    // Check for shared token for internal API calls
    const sharedToken = process.env.SHARED_API_TOKEN;
    if (sharedToken && req.headers['x-shared-token'] === sharedToken) {
      // Create a system user for internal API calls
      res.locals.user = {
        id: 'system',
        user_id: 'system',
        name: 'System User (Internal API)',
        isSystem: true
      };
      res.locals.user.sql = { where: { userId: 'system' } };
      next();
      return;
    }

    if (isAgentDbPath) {
      res.status(403).json({ message: 'Forbidden: agent-db is internal only' });
      return;
    }
    try {
      const [bearer, token] = (req.headers?.authorization && req.headers?.authorization?.split(" ")) || [];
      if (bearer === 'Bearer' && token) {
        let type, instance;
        try {
          ([type, instance] = atob(token).split(':'));
        }
        catch (e) {
        }
        req.log.debug({ type, instance, path: req.path }, 'token type');
        // Single use join token
        if (type === 'instance') {
          if (req.path === `/api/rooms/${instance}/join`) {
            let dbInstance = await Instance.findByPk(instance);
            if (dbInstance && dbInstance.key === token) {
              res.locals.instance = dbInstance;
              next();
            }
            else {
              throw new Error('Instance token auth error');
            }
          }
          else {
            throw new Error('Path instance token error, check path');
          }
        }
        // Some other bearer token
        else if (type !== 'instance') {
          // Check for a static auth key.
          let { user, expiry } = await AuthKey.verify(token) || {};
          if (user) {
            await attachRbac(user);
            res.locals.user = user;
            res.locals.userAuth = true;
            res.locals.userAuthExpiry = expiry;
            res.locals.user.sql = { where: scopeWhereForUser(user) };
            res.locals.userAuth = true;
            if (!gateAccount(res)) return;   // owner must be active + org active (key never outlives owner)
            next();
          }
          else {
            // Better-Auth session (parallel to Firebase). The session token is
            // carried as a Bearer token via the bearer plugin. Resolved sessions
            // are cached in-process (keyed on the token) so getSession's Postgres
            // lookup runs at most once per token per TTL; getSession returns null
            // for a non-Better-Auth token (e.g. a Firebase JWT) without a DB read,
            // so we fall through to Firebase verification below.
            let baUser = getCachedBaUser(token);
            if (!baUser && betterAuth) {
              try {
                const session = await betterAuth.api.getSession({ headers: fromNodeHeaders(req.headers) });
                if (session?.user) {
                  baUser = await User.findByPk(session.user.id);
                  if (baUser) setCachedBaUser(token, baUser);
                }
              }
              catch (e) {
                req.log.debug({ e: e.message }, 'not a better-auth session');
              }
            }
            if (baUser) {
              // Unified table: the Better-Auth user row IS our app `users` row.
              await attachRbac(baUser);
              res.locals.user = baUser;
              res.locals.userAuth = true;
              res.locals.user.sql = { where: scopeWhereForUser(res.locals.user) };
              if (!gateAccount(res)) return;   // provisional/suspended user or inactive org => 403
              next();
            }
            else {
              let user = await firebase
                .getAuth()
                .verifyIdToken(token);
              req.log.debug({ user, token }, 'firebase auth');
              if (user) {
                res.locals.user = await User.import({ ...user, id: user.user_id });
                await attachRbac(res.locals.user);
                res.locals.user.sql = { where: scopeWhereForUser(res.locals.user) };
                if (!gateAccount(res)) return;   // suspended user or inactive org => 403
                next();
              }
              else {
                throw new Error('firebase auth error');
              }
            }
          }
        }
      }
      else {
          throw new Error(`Authentication error: no Auth header!`);
      }
    }
    catch (e) {
      req.log.error({ message: e.message, error: e.stack }, 'Auth error');
      res.status(401)
        .json({ message: e.message || `Authentication error` });
    }
  });
}

export default init;
