import dotenv from 'dotenv';

export default () => {
  dotenv.config();
  // Nuke all the database config because we are using a test database container even in a real environment
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('POSTGRES_')) {
      delete process.env[key];
    }
  });
};

