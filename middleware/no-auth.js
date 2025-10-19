import { User } from '../lib/database.js';

const defaultUser = {
  user_id: 'defaultNotAuthenticated',
  name: 'Default User (this instance has no authentication)'
}

function init(app, logger) {
  // Pretend we have authenticated a default user because we don't do auth in this instance
  app.use((req, res, next) => {
    res.locals.user = defaultUser;
    User.import({ ...defaultUser, id: defaultUser.user_id })
      .then(next)
  });

}
export default init;