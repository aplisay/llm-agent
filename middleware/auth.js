import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { Instance, User, AuthKey } from '../lib/database.js';
import { scopeWhereForUser } from '../lib/scope.js';
import * as firebase from 'firebase-admin/auth';
import { auth as betterAuth } from '../lib/auth/index.js';
import { fromNodeHeaders } from 'better-auth/node';

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
function gateProvisional(res) {
  if (!isActive(res.locals.user)) {
    res.status(403).json({ message: 'account_pending', detail: 'Your account is awaiting activation.' });
    return false;
  }
  return true;
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
            res.locals.user = user;
            res.locals.userAuth = true;
            res.locals.userAuthExpiry = expiry;
            res.locals.user.sql = { where: scopeWhereForUser(user) };
            res.locals.userAuth = true;
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
              res.locals.user = baUser;
              res.locals.userAuth = true;
              res.locals.user.sql = { where: scopeWhereForUser(res.locals.user) };
              if (!gateProvisional(res)) return;   // provisional/suspended => 403 account_pending
              next();
            }
            else {
              let user = await firebase
                .getAuth()
                .verifyIdToken(token);
              req.log.debug({ user, token }, 'firebase auth');
              if (user) {
                res.locals.user = await User.import({ ...user, id: user.user_id });
                res.locals.user.sql = { where: scopeWhereForUser(res.locals.user) };
                if (!gateProvisional(res)) return;   // suspended/deactivated => 403 account_pending
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
