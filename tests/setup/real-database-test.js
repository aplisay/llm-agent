// Database test wrapper that uses the real database.js file
// This ensures we test against the actual database logic, not a replica
// Uses hardwired container database connection info

let realDb;
let isInitialized = false;

export async function setupRealDatabase() {
  if (isInitialized) {
    return realDb;
  }

  // Store original environment variables
  const originalEnv = {
    POSTGRES_HOST: process.env.POSTGRES_HOST,
    POSTGRES_PORT: process.env.POSTGRES_PORT,
    POSTGRES_DB: process.env.POSTGRES_DB,
    POSTGRES_USER: process.env.POSTGRES_USER,
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
    CREDENTIALS_KEY: process.env.CREDENTIALS_KEY,
    DB_FORCE_SYNC: process.env.DB_FORCE_SYNC,
    POSTGRES_CA: process.env.POSTGRES_CA,
    POSTGRES_KEY: process.env.POSTGRES_KEY,
    POSTGRES_CERT: process.env.POSTGRES_CERT,
    POSTGRES_RO_SERVER_NAME: process.env.POSTGRES_RO_SERVER_NAME
  };

  // Set up hardwired test environment variables for container database
  process.env.POSTGRES_HOST = 'localhost';
  process.env.POSTGRES_PORT = '5433';
  process.env.POSTGRES_DB = 'llmvoicetest';
  process.env.POSTGRES_USER = 'testuser';
  process.env.POSTGRES_PASSWORD = 'testpass';
  process.env.CREDENTIALS_KEY = 'test-secret-key-for-encryption';
  process.env.DB_FORCE_SYNC = 'true';

  // Disable SSL for test database
  delete process.env.POSTGRES_CA;
  delete process.env.POSTGRES_KEY;
  delete process.env.POSTGRES_CERT;
  delete process.env.POSTGRES_RO_SERVER_NAME;

  // Import the real database module with the correct environment
  const dbModule = await import('../../lib/database.js');
  
  // Wait for database to be ready
  await dbModule.databaseStarted;
  
  // Sync the database schema to ensure all tables exist
  // We need to get the sequelize instance from the models
  const { Organisation } = dbModule;
  await Organisation.sequelize.sync({ force: true });

  realDb = {
    models: {
      Organisation: dbModule.Organisation,
      User: dbModule.User,
      PhoneNumber: dbModule.PhoneNumber,
      PhoneRegistration: dbModule.PhoneRegistration,
      Agent: dbModule.Agent,
      Instance: dbModule.Instance,
      Call: dbModule.Call,
      TransactionLog: dbModule.TransactionLog,
      AuthKey: dbModule.AuthKey,
      Trunk: dbModule.Trunk
    },
    sequelize: dbModule.Sequelize,
    stopDatabase: dbModule.stopDatabase,
    originalEnv
  };

  isInitialized = true;
  return realDb;
}

export async function teardownRealDatabase() {
  if (realDb && isInitialized) {
    // Stop the real database
    await realDb.stopDatabase();
    
    // Restore original environment variables
    Object.assign(process.env, realDb.originalEnv);
    
    isInitialized = false;
    realDb = null;
  }
}

export function getRealDatabase() {
  if (!isInitialized) {
    throw new Error('Database not initialized. Call setupRealDatabase() first.');
  }
  return realDb;
}
