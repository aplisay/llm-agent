const { initializeApp, applicationDefault } = require('firebase-admin/app');
const firebase = require('firebase-admin/auth');

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

  // Install a route that looks for an access token and tries to divine the Firebase user if it finds one.

  app.use((req, res, next) => {
    const [bearer, token] = (req.headers?.authorization && req.headers?.authorization?.split(" ")) || [];
    if (bearer === 'Bearer' && token) {
      res.locals.userAuth = true;
      return firebase
        .getAuth()
        .verifyIdToken(token)
        .then((user) => {
          res.locals.user = user;
          next();
        })
        .catch((authError) => {
          res.locals.user = undefined;
          res.locals.userAuthError = authError;
          req.log.error({ authError }, 'Auth error');
          res.status(401)
            .json({ message: `Authentication error` });
        });
    }
    else {
      if (req.originalUrl.startsWith('/api/api-docs')) {
        next();
      }
      else {
        req.log.error({ headers: req.headers, bearer, token }, 'No auth header!');
        res.status(401)
          .json({ message: `Authentication error: no Auth header!` });
      }
    }
  });

}


module.exports = init;
