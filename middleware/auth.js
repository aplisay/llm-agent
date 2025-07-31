import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { Instance, User, AuthKey, Op } from '../lib/database.js';
import * as firebase from 'firebase-admin/auth';

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
     ) {
      next();
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
            res.locals.user.sql = { where: { userId: user.id } };
            res.locals.userAuth = true;
            next();
          }
          else {
            let user = await firebase
              .getAuth()
              .verifyIdToken(token);
            req.log.debug({ user, token }, 'firebase auth');
            if (user) {
              res.locals.user = await User.import({ ...user, id: user.user_id });
              res.locals.user.sql = { where: { userId: res.locals.user.id } };
              next();
            }
            else {
              throw new Error('firebase auth error');
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
